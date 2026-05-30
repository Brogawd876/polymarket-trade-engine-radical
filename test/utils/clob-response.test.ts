import { describe, expect, test } from "bun:test";
import { extractOrderId, responseError } from "../../utils/clob-response.ts";

describe("CLOB response helpers", () => {
  test("treats API error objects and HTTP failures as failures", () => {
    expect(responseError({ error: "bad signer", status: 400 })).toBe(
      '{"error":"bad signer","status":400}',
    );
    expect(responseError({ status: 500, message: "server" })).toBe(
      '{"status":500,"message":"server"}',
    );
    expect(responseError({ success: false, errorMsg: "rejected" })).toBe(
      "rejected",
    );
  });

  test("extracts real order ids only from accepted responses", () => {
    expect(extractOrderId({ orderID: "abc" })).toBe("abc");
    expect(extractOrderId({ orderId: "def" })).toBe("def");
    expect(extractOrderId({ id: "ghi" })).toBe("ghi");
    expect(extractOrderId({ error: "bad signer", status: 400 })).toBeNull();
  });
});
