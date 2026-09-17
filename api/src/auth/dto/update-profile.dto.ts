import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(24, { message: '昵称最多 24 个字' })
  nickname?: string;

  /** 微信新版头像昵称填写能力返回的临时文件已先上传到我们的存储，这里存最终 URL。 */
  @IsOptional()
  @IsUrl({ require_protocol: true }, { message: '头像地址不合法' })
  @MaxLength(512)
  avatarUrl?: string;
}

