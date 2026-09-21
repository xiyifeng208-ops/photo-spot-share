import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSpotDto, UpdateSpotDto } from './spot.dto';

const validPayload = {
  title: '外滩三件套机位',
  description: '长焦压角，江面留倒影',
  lat: 31.2397,
  lng: 121.4903,
  heading: 'NE',
  bestTimes: ['sunset', 'blue_hour'],
  bestSeasons: ['autumn'],
  focalLength: 'tele',
  difficulty: 2,
  accessNote: '地铁 2 号线南京东路站',
  photoKeys: ['uploads/11111111-1111-4111-8111-111111111111/20260915/a.jpg'],
};

async function validateCreate(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreateSpotDto, payload) as object, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
}

function messagesOf(errors: Array<{ constraints?: Record<string, string> }>): string[] {
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('CreateSpotDto', () => {
  it('合法载荷可以通过校验', async () => {
    expect(await validateCreate(validPayload)).toHaveLength(0);
  });

  // 回归：photoKeys 曾经误用字符串校验器 @MinLength，导致"带 1 张照片创建"永远 400
  it('单张样张可以通过校验', async () => {
    const errors = await validateCreate({ ...validPayload, photoKeys: ['uploads/u/1/a.jpg'] });
    expect(errors).toHaveLength(0);
  });

  it('空数组样张被拒绝且提示中文', async () => {
    const errors = await validateCreate({ ...validPayload, photoKeys: [] });
    expect(messagesOf(errors)).toContain('至少上传 1 张样张');
  });

  it('超过 9 张样张被拒绝', async () => {
    const photoKeys = Array.from({ length: 10 }, (_, index) => `uploads/u/1/${index}.jpg`);
    const errors = await validateCreate({ ...validPayload, photoKeys });
    expect(messagesOf(errors)).toContain('每个打卡点最多 9 张样张');
  });

  it('标题过短被拒绝', async () => {
    const errors = await validateCreate({ ...validPayload, title: '短' });
    expect(messagesOf(errors)).toContain('标题至少 2 个字');
  });

  it('经纬度超出范围被拒绝', async () => {
    const errors = await validateCreate({ ...validPayload, lat: 95, lng: 200 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('枚举取值不合法被拒绝', async () => {
    const errors = await validateCreate({
      ...validPayload,
      heading: 'UP',
      bestTimes: ['dawn'],
      focalLength: 'fisheye',
      difficulty: 9,
    });
    const messages = messagesOf(errors);
    expect(messages).toContain('机位朝向取值不合法');
    expect(messages).toContain('推荐时段取值不合法');
    expect(messages).toContain('推荐焦段取值不合法');
    expect(messages).toContain('难度取值为 1-3');
  });
});

describe('UpdateSpotDto', () => {
  it('null clears only nullable scalar fields and empty arrays clear tags', async () => {
    expect(await validate(plainToInstance(UpdateSpotDto, {
      heading: null, focalLength: null, difficulty: null, accessNote: null,
      bestTimes: [], bestSeasons: [], description: '',
    }))).toHaveLength(0);
  });

  it.each(['title', 'description', 'lat', 'lng', 'bestTimes', 'bestSeasons', 'photoKeys', 'geo'])(
    'rejects null %s rather than silently treating it as omitted', async field => {
      expect((await validate(plainToInstance(UpdateSpotDto, { [field]: null }))).length).toBeGreaterThan(0);
    },
  );

  it('requires at least one retained photo', async () => {
    expect((await validate(plainToInstance(UpdateSpotDto, { photoKeys: [] }))).length).toBeGreaterThan(0);
  });
  it('允许只传要改的字段', async () => {
    const errors = await validate(plainToInstance(UpdateSpotDto, { title: '换个标题' }) as object);
    expect(errors).toHaveLength(0);
  });

  it('空对象也合法（等价于不改任何字段）', async () => {
    const errors = await validate(plainToInstance(UpdateSpotDto, {}) as object);
    expect(errors).toHaveLength(0);
  });

  it('图片数量上限仍然生效', async () => {
    const photoKeys = Array.from({ length: 10 }, (_, index) => `uploads/u/1/${index}.jpg`);
    const errors = await validate(plainToInstance(UpdateSpotDto, { photoKeys }) as object);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('CreateSpotDto unknown information', () => {
  it('supports unknown nullable scalars and empty tags', async () => {
    expect(await validateCreate({ ...validPayload, heading: null, focalLength: null,
      difficulty: null, accessNote: null, bestTimes: [], bestSeasons: [] })).toHaveLength(0);
  });
  it.each(['bestTimes', 'bestSeasons', 'description', 'geo'])(
    'rejects null %s', async field => {
      expect((await validateCreate({ ...validPayload, [field]: null })).length).toBeGreaterThan(0);
    },
  );
});
