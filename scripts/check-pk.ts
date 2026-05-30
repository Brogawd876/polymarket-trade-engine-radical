import { Wallet } from "@ethersproject/wallet";
import { Env } from "../utils/config.ts";

const pk = Env.get("PRIVATE_KEY");
const w = new Wallet(pk);
console.log("EOA Address:", w.address);
