import type { NoticeSink } from "../../src/types";

export interface CapturedNotice {
  message: string;
  durationMs?: number;
}

export class CapturedNoticeSink implements NoticeSink {
  public notices: CapturedNotice[] = [];

  show(message: string, durationMs?: number): void {
    this.notices.push({ message, durationMs });
  }
}
