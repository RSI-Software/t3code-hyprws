export const ACTIVITY_DETAIL_MAX_LENGTH = 180;

export function truncateActivityDetail(value: string, limit = ACTIVITY_DETAIL_MAX_LENGTH): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}
