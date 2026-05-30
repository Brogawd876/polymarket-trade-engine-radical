# Handoff: Type 3 Deposit Wallet Corrected

## Status

Branch: `master`

The live Type 3 order path is proven end to end and must be preserved.

- Owner signer: `0x3528764a45bB13eC6BD8Deb1a73b5034742E6329`
- Correct POLY_1271 deposit wallet / `POLY_FUNDER_ADDRESS`: `0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51`
- Disproven funders: `0xbcbae6BE8cE9AD38C4FFD71254202f2aA27a30CF`, `0x609df252DF1371DBABD7aA234e028ACe9EAd90A2`
- CLOB credentials are freshly derived from the owner signer. Static `POLY_API_*` values are not authoritative for this flow.
- Raw Type 3 orders must build with maker/signer equal to the deposit wallet, `signatureType=3`, and order version `2`.

## Proven Acceptance Evidence

- `npm run check` passed before the acceptance run.
- Balance diagnostics showed approximately `$5` pUSD / CLOB balance on the corrected deposit wallet.
- `check-clob.ts` authenticated and open orders were `0` before the test.
- `verify-raw-order.ts` showed maker/signer `0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51`, `signatureType=3`, order version `2`.
- Live BTC 5-minute acceptance submitted a tiny order, received order ID `0xcd265e048093af8a07f4a5aa323d80698d4a99a1f0dab747cde7575196690028`, canceled it successfully, and verified no stray open order remained.

## Configuration Rules

- Keep `POLY_SIGNATURE_TYPE=3`.
- Keep `POLY_FUNDER_ADDRESS=0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51` for the current owner only.
- For a different owner wallet, derive the deposit wallet using `@polymarket/builder-relayer-client` `deriveDepositWallet(...)`; do not copy the current funder blindly.
- `BUILDER_*` credentials are only for relayer operations such as wrap/unwrap/redeem, not CLOB auth selection.

## Recommended Checks

```powershell
npm run check
bun test test/engine/type3-account-model.test.ts test/utils/clob-response.test.ts
bun run scripts/credential-ambiguity-diagnostic.ts
bun run scripts/check-balance.ts
bun run scripts/check-clob.ts
bun run scripts/verify-raw-order.ts
```
