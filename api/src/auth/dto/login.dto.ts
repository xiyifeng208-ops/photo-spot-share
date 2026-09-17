import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class WxLoginDto {
  /** wx.login 拿到的 code；本地开发模式下传 `dev:<设备ID>`。 */
  @IsString()
  @IsNotEmpty({ message: 'code 不能为空' })
  @MaxLength(512)
  code!: string;
}

