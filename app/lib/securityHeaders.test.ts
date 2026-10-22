import { describe, it, expect } from "vitest";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from "./securityHeaders";

const directive = (name: string) => CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith(`${name} `)) || "";

describe("securityHeaders", () => {
  it("スクリプトは自分のサイトだけ。外部のスクリプト・eval は許さない", () => {
    expect(directive("script-src")).toBe("script-src 'self' 'unsafe-inline'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
  });

  it("ほかのサイトに埋め込ませない", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(SECURITY_HEADERS.find((h) => h.key === "X-Frame-Options")?.value).toBe("DENY");
  });

  it("メールの画像（押したとき）・添付のプレビュー・Google のログインを止めない", () => {
    expect(directive("img-src")).toContain("https:");
    expect(directive("frame-src")).toContain("blob:");
    expect(directive("media-src")).toContain("data:");
    expect(directive("form-action")).toContain("https://accounts.google.com");
  });

  it("リンク先に Re:Mail の URL を伝えない", () => {
    expect(SECURITY_HEADERS.find((h) => h.key === "Referrer-Policy")?.value).toBe("no-referrer");
  });
});
