#!/usr/bin/env node
/**
 * Real-network smoke check for the rail's read path.
 *
 * Exercises the same RPC call the rail makes in `verify()` (`rpc.blockInfo`)
 * against the public Nano network (rpc.nano.to), on a real block. This is
 * read-only: no send, no wallet, no funds moved. It proves the rail's
 * integration point — a `block_info` lookup returning confirmed/subtype/amount —
 * is faithful to the live network, and it surfaces how confirmation is read.
 *
 * Honest boundary: the rail's full send/verify/refund path needs a funded
 * signer/verifier (a real Nano or test-Nano key that can publish and receive
 * blocks). This run holds no wallet and moves no funds, so it verifies the read
 * path against the live network and runs the send/verify/refund logic against
 * the fake provider in the unit + conformance suites.
 *
 * Usage: node examples/rpc-network-check.mjs
 */
const RPC = 'https://rpc.nano.to';
const ACCOUNT = 'nano_1banexkcfuieufzxksfrxqf6xy8e57ry1zdtq9yn7jntzhpwu4pg4hajojmq';
const BLOCK = 'E792FD1FE71FA6C111BC5545747F828348C3CE2EBE8D3173D0BE344F09FC62FE';

async function rpc(action, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  if (!res.ok) throw new Error(`rpc.nano.to answered HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`rpc.nano.to ${action}: ${data.error}`);
  return data;
}

async function blockInfo(hash) {
  const data = await rpc('block_info', { hash });
  // Mirror the rail's NanoBlockInfo read model.
  return {
    hash,
    confirmed: data.confirmed === true,
    source: data.block_account,
    destination: data.link_account ?? data.block_account,
    amountRaw: data.amount,
    subtype: data.subtype,
  };
}

async function main() {
  const block = await blockInfo(BLOCK);
  console.log(`block_info on a real public-network block:`);
  console.log(`  hash:        ${block.hash}`);
  console.log(`  confirmed:   ${block.confirmed}`);
  console.log(`  subtype:     ${block.subtype}`);
  console.log(`  amountRaw:   ${block.amountRaw}`);
  console.log(`  account:     ${block.source}`);

  // Cross-check confirmation independently via the account's confirmation height.
  const info = await rpc('account_info', { account: ACCOUNT });
  const chFrontier = info.confirmation_height_frontier;
  const ch = info.confirmation_height;
  console.log(`  confirmation_height: ${ch} (frontier ${chFrontier?.slice(0, 16)}…)`);
  const onChainHeight = chFrontier === BLOCK;
  console.log(`  block is the account's confirmed frontier: ${onChainHeight}`);

  if (block.confirmed || onChainHeight) {
    console.log(`\nRESULT: the rail's rpc.blockInfo() contract (confirmed + subtype + amount) is satisfied by the live public Nano network.`);
  } else {
    console.log(`\nRESULT: read path works (block_info returns real data), but rpc.nano.to reported confirmed=false for this receive block. In production a merchant should confirm a send via the network's confirmation height, matching what the rail's 'exact confirmed send to merchant' check requires.`);
  }
}

main().catch((e) => {
  console.error(`RESULT: read path FAILED against the live network — ${e.message}`);
  process.exit(1);
});
