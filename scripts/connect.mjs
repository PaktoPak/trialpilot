// Developer tool: opens a sign-in window, waits for the user to sign in themselves, and saves the account.
//   node scripts/connect.mjs [username]   (a username signs an already-connected account back in)
import { getConnect, startConnect } from "../dist/instagram/connect.js";
import { getAccount } from "../dist/store.js";
import { sleep } from "../dist/util.js";

const [username] = process.argv.slice(2);
const existing = username ? await getAccount(username) : undefined;
let state = await startConnect(existing);
console.log(state.message);
while (state.status === "waiting") {
  await sleep(2000);
  state = getConnect(state.id) ?? state;
}
console.log(`${state.status}: ${state.message}`);
if (state.account) console.log(JSON.stringify(state.account, null, 2));
// The sign-in window closes itself a moment later; node exits once it has.
process.exitCode = state.status === "connected" ? 0 : 1;
