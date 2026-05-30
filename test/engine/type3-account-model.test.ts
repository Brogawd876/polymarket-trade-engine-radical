import { describe, expect, test } from "bun:test";
import { Wallet } from "@ethersproject/wallet";
import {
  Chain,
  ClobClient,
  Side,
  type TickSize,
} from "@polymarket/clob-client-v2";
import { deriveDepositWallet } from "@polymarket/builder-relayer-client";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";

const OWNER = "0x3528764a45bB13eC6BD8Deb1a73b5034742E6329";
const EXPECTED_FUNDER = "0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51";
const WRONG_FUNDERS = [
  "0xbcbae6BE8cE9AD38C4FFD71254202f2aA27a30CF",
  "0x609df252DF1371DBABD7aA234e028ACe9EAd90A2",
];

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

describe("Type 3 account model guardrails", () => {
  test("official deposit-wallet derivation matches the persisted funder", () => {
    const contractConfig = getContractConfig(Chain.POLYGON);
    const depositWalletConfig = contractConfig.DepositWalletContracts;
    const derived = deriveDepositWallet(
      OWNER,
      depositWalletConfig.DepositWalletFactory,
      depositWalletConfig.DepositWalletImplementation,
    );

    expect(sameAddress(derived, EXPECTED_FUNDER)).toBe(true);
  });

  test("offline Type 3 order builder uses the deposit wallet as maker and signer", async () => {
    const signer = new Wallet(
      "0x1234567890123456789012345678901234567890123456789012345678901234",
    );
    const clob = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer,
      creds: { key: "key", secret: "secret", passphrase: "passphrase" },
      signatureType: 3,
      funderAddress: EXPECTED_FUNDER,
    });

    const order = await clob.orderBuilder.buildOrder(
      {
        tokenID: "1234567890123456789012345678901234567890",
        price: 0.01,
        size: 100,
        side: Side.BUY,
      },
      { tickSize: "0.01" as TickSize, negRisk: false },
      2,
    );

    expect(sameAddress(order.maker, EXPECTED_FUNDER)).toBe(true);
    expect(sameAddress(order.signer, EXPECTED_FUNDER)).toBe(true);
    expect(Number(order.signatureType)).toBe(3);
  });

  test("active sample config keeps the proven funder placeholder and blocks old funders", async () => {
    const envSample = await Bun.file(".env.sample").text();
    expect(envSample).toContain("POLY_FUNDER_ADDRESS=0xYOUR_DEPOSIT_WALLET_HERE");
    for (const wrong of WRONG_FUNDERS) {
      expect(envSample).not.toContain(`POLY_FUNDER_ADDRESS=${wrong}`);
    }
  });

  test("setup UI does not offer static CLOB API credentials as an auth bypass", async () => {
    const setup = await Bun.file("setup_env.py").text();
    // Nonce is allowed, but the actual key/secret/passphrase are blocked
    expect(setup).not.toMatch(/POLY_API_KEY(?!_NONCE)/);
    expect(setup).not.toContain("POLY_API_SECRET");
    expect(setup).not.toContain("POLY_API_PASSPHRASE");
  });

  test("production client does not read static POLY_API credentials", async () => {
    const clientSource = await Bun.file("engine/client.ts").text();
    expect(clientSource).not.toMatch(/Env\.get\(["']POLY_API_/);
    expect(clientSource).not.toMatch(
      /process\.env\.POLY_API_(KEY(?!_NONCE)|SECRET|PASSPHRASE)\b/,
    );
  });
});
