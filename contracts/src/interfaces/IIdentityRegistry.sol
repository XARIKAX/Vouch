// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The slice of the ERC-8004 Identity Registry (an ERC-721) that Vouch
/// Credit relies on: an agentId exists when it has an owner. On Robinhood Chain
/// mainnet the registry lives at 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432.
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function register(string calldata agentURI) external returns (uint256 agentId);
}
