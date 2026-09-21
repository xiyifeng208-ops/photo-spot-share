import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import catalogue from './mainland-regions.json';
import { normalizeRegion, supplementGeo } from './region.util';

describe('mainland region normalization', () => {
  it('backend catalogue exactly matches the current mini-program picker', () => {
    const frontend = readFileSync(join(__dirname, '../../../miniprogram/data/cities.js'), 'utf8');
    expect(catalogue).toEqual(JSON.parse(frontend.split('module.exports = ')[1].trim().replace(/;$/, '')));
    expect(catalogue.provinces).toHaveLength(31);
  });
  it.each(['北京市', '天津市', '上海市', '重庆市'])('normalizes municipality %s', name => {
    expect(normalizeRegion({ province: name, city: null, district: '示例区' }))
      .toEqual({ province: name, city: name, district: '示例区', address: null });
    expect(normalizeRegion({ city: name })?.province).toBe(name);
  });
  it('normalizes a normal city and trims text', () => {
    expect(normalizeRegion({ province: ' 浙江省 ', city: ' 杭州市 ', district: '西湖区', address: ' 苏堤 ' }))
      .toEqual({ province: '浙江省', city: '杭州市', district: '西湖区', address: '苏堤' });
  });
  it.each([
    { province: '湖北省', city: null, district: '仙桃市' },
    { province: '湖北省', city: '仙桃市' },
    { province: '湖北省', city: '省直辖县级行政区划', district: '仙桃市' },
  ])('normalizes direct province-administered region %j', input => {
    expect(normalizeRegion(input)).toEqual({ province: '湖北省', city: null, district: '仙桃市', address: null });
  });
  it.each([
    {}, { province: '湖北省' }, { province: '上海市', city: '杭州市' },
    { province: '浙江省', city: '上海市' }, { province: '台湾省', city: '台北市' },
    { province: '湖北省', city: '仙桃市', district: '天门市' },
    { province: '湖北省', city: '武汉市', district: '仙桃市' },
  ])('rejects incomplete, mismatched, or out-of-scope regions %j', input => {
    expect(normalizeRegion(input)).toBeNull();
  });
  it('fills absent fields without overriding manual address', () => {
    expect(supplementGeo({ address: '手填路口' }, {
      province: '上海市', city: '上海市', district: '黄浦区', address: '高德地址',
    })).toEqual({ province: '上海市', city: '上海市', district: '黄浦区', address: '手填路口' });
  });
  it('does not mix metadata from conflicting regions', () => {
    expect(supplementGeo({ province: '浙江省', address: '手填地址' }, {
      province: '上海市', city: '上海市', district: '黄浦区', address: '高德地址',
    })).toEqual({ province: '浙江省', city: null, district: null, address: '手填地址' });
  });
});
