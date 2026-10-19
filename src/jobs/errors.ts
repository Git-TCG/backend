/** 지금은 실패했지만 시간이 지나면 성공할 작업. 재시도 횟수를 쓰지 않고 지정한 시간 뒤에 다시 실행한다. */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly delayMs: number,
  ) {
    super(message);
  }
}
