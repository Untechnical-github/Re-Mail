import { describe, it, expect } from "vitest";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, buildContentSecurityPolicy, generateNonce, withNonceRequest, withNonceResponse } from "./securityHeaders";

const directiveOf = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) || "";
const directive = (name: string) => directiveOf(CONTENT_SECURITY_POLICY, name);

describe("securityHeaders", () => {
  it("スクリプトは自分のサイトだけ。インラインのスクリプト・外部のスクリプト・eval は許さない", () => {
    expect(directive("script-src")).toBe("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
  });

  it("nonce 付きの版は、その nonce のインラインスクリプトだけを許す（unsafe-inline は付けない）", () => {
    const csp = buildContentSecurityPolicy("abc123==");
    expect(directiveOf(csp, "script-src")).toBe("script-src 'self' 'nonce-abc123=='");
    expect(directiveOf(csp, "script-src")).not.toContain("unsafe-inline");
    // style-src に nonce を入れると unsafe-inline が無視され、style 属性が効かなくなる
    expect(directiveOf(csp, "style-src")).not.toContain("nonce-");
  });

  it("next.config.ts の headers() には CSP を入れない（OpenNext がリクエストの CSP を上書きし、nonce が消えるため）", () => {
    expect(SECURITY_HEADERS.some((h) => h.key.toLowerCase() === "content-security-policy")).toBe(false);
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

describe("nonce", () => {
  it("毎回ちがう、16バイト分の base64 を作る", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("リクエストの CSP ヘッダーは、ブラウザが送ってきたものを捨てて上書きする", () => {
    const req = new Request("https://example.com/", {
      headers: { "content-security-policy": "script-src 'nonce-attacker'", "content-security-policy-report-only": "script-src 'nonce-attacker'", accept: "text/html" },
    });
    const out = withNonceRequest(req, "server");
    expect(out.headers.get("content-security-policy")).toContain("'nonce-server'");
    expect(out.headers.get("content-security-policy")).not.toContain("attacker");
    expect(out.headers.get("content-security-policy-report-only")).toBeNull();
    // ほかのヘッダーと URL・メソッドはそのまま
    expect(out.headers.get("accept")).toBe("text/html");
    expect(out.url).toBe("https://example.com/");
    expect(out.method).toBe("GET");
  });

  it("POST の本文もそのまま渡す", async () => {
    const req = new Request("https://example.com/api/config", { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } });
    const out = withNonceRequest(req, "n");
    expect(out.method).toBe("POST");
    expect(await out.text()).toBe('{"a":1}');
  });

  it("HTML の応答には nonce 付きの CSP、それ以外には nonce の無い CSP を付け、状態と本文とほかのヘッダーは変えない", async () => {
    const html = new Response("<p>hi</p>", { status: 200, headers: { "content-type": "text/html; charset=utf-8", "x-other": "1" } });
    const out = withNonceResponse(html, "n1");
    expect(out.headers.get("content-security-policy")).toContain("'nonce-n1'");
    expect(out.headers.get("x-other")).toBe("1");
    expect(out.status).toBe(200);
    expect(await out.text()).toBe("<p>hi</p>");

    const json = withNonceResponse(new Response("{}", { status: 401, headers: { "content-type": "application/json" } }), "n1");
    expect(json.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(json.status).toBe(401);
    expect(await json.text()).toBe("{}");
  });

  it("本文の無い応答（リダイレクト）でも壊れない", () => {
    const redirect = new Response(null, { status: 307, headers: { location: "/x", "content-type": "text/html" } });
    const out = withNonceResponse(redirect, "n");
    expect(out.status).toBe(307);
    expect(out.headers.get("location")).toBe("/x");
  });
});
