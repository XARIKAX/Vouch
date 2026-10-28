// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CreditRegistry} from "../src/CreditRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";

/// @notice Deploys Vouch Credit against the addresses in deployments/<chainId>.json
/// and writes the result back there. A chain without a record is refused: the
/// external contracts (ERC-8004 identity registry, USDG) must be resolved from the
/// record, never typed in. The local devnet (chain 31337) is the one exception:
/// without a record it gets mocks and a fresh record.
///
///   ATTESTER=0x...      the engine's attester address (defaults to the broadcaster on devnet)
///   CREDIT_LINE_CAP=1000000000   cap in USDG base units (default $1,000)
contract Deploy is Script {
    uint256 constant DEVNET = 31337;

    function run() external {
        uint256 chainId = block.chainid;
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(chainId), ".json");

        address identity;
        address usdg;
        string memory chainName;
        string memory rpc;
        string memory explorer;

        if (vm.exists(path)) {
            string memory json = vm.readFile(path);
            identity = vm.parseJsonAddress(json, ".identityRegistry");
            usdg = vm.parseJsonAddress(json, ".usdg");
            chainName = vm.parseJsonString(json, ".name");
            rpc = vm.parseJsonString(json, ".rpc");
            explorer = vm.parseJsonString(json, ".explorer");
            if (chainId == DEVNET) {
                // a devnet restarts empty: a stale record's mocks are redeployed
                if (identity.code.length == 0) identity = address(0);
                if (usdg.code.length == 0) usdg = address(0);
            } else {
                require(identity != address(0) && usdg != address(0), "deployment record lacks identityRegistry/usdg");
            }
        } else if (chainId == DEVNET) {
            chainName = "Local devnet";
            rpc = "http://127.0.0.1:8545";
            explorer = "";
        } else {
            revert(string.concat("no deployment record for chain ", vm.toString(chainId), ": refusing to deploy"));
        }

        address attester = vm.envOr("ATTESTER", address(0));
        uint256 cap = vm.envOr("CREDIT_LINE_CAP", uint256(1000e6));

        vm.startBroadcast();
        address broadcaster = msg.sender;
        if (attester == address(0)) {
            require(chainId == DEVNET, "ATTESTER is required outside the devnet");
            attester = broadcaster;
        }
        if (identity == address(0)) identity = address(new MockIdentityRegistry());
        if (usdg == address(0)) usdg = address(new MockUSDG());
        CreditRegistry registry = new CreditRegistry(IIdentityRegistry(identity), attester, cap);
        vm.stopBroadcast();

        string memory out = "deployment";
        vm.serializeUint(out, "chainId", chainId);
        vm.serializeString(out, "name", chainName);
        vm.serializeString(out, "rpc", rpc);
        vm.serializeString(out, "explorer", explorer);
        vm.serializeAddress(out, "identityRegistry", identity);
        vm.serializeAddress(out, "usdg", usdg);
        vm.serializeAddress(out, "attester", attester);
        vm.serializeAddress(out, "creditRegistry", address(registry));
        vm.serializeString(out, "creditPool", "");
        vm.serializeUint(out, "creditLineCap", cap);
        string memory finalJson = vm.serializeUint(out, "deployedAt", block.timestamp);
        vm.writeJson(finalJson, path);

        console.log("chain", chainId);
        console.log("identityRegistry", identity);
        console.log("usdg", usdg);
        console.log("attester", attester);
        console.log("creditRegistry", address(registry));
        console.log("record", path);
    }
}
