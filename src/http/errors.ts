/** 사용자에게 그대로 보여 줄 수 있는 요청 오류. 500은 내부 오류로만 쓴다. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorized = (message = "로그인이 필요합니다") => new HttpError(401, message);
export const forbidden = (message: string) => new HttpError(403, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const unavailable = (message: string) => new HttpError(503, message);
