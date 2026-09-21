import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const FEEDBACK_KINDS = ['still_accessible', 'location_changed', 'access_restricted', 'obstructed'] as const;
export type FeedbackKind = typeof FEEDBACK_KINDS[number];
export const FEEDBACK_LABELS: Record<FeedbackKind, string> = {
  still_accessible: '仍可拍摄',
  location_changed: '位置有变化',
  access_restricted: '入口受限',
  obstructed: '现场遮挡',
};

export class PutFeedbackDto {
  @IsIn(FEEDBACK_KINDS, { message: '请选择有效的机位反馈类型' })
  kind!: FeedbackKind;
}

export class ListFeedbackDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:[1-9]|1[0-9]|20)$/, { message: 'limit 必须是 1 到 20 的整数' })
  limit?: string;
}

