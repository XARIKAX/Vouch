// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Devnet stand-in for the ERC-8004 Identity Registry: the ERC-721 surface
/// Vouch Credit uses. `register` mints the next agentId to the caller; `ownerOf`
/// reverts for an unknown id exactly like a real ERC-721 does.
contract MockIdentityRegistry {
    uint256 public nextId = 1;
    mapping(uint256 => address) private owners;
    mapping(uint256 => string) public tokenURI;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = nextId++;
        owners[agentId] = msg.sender;
        tokenURI[agentId] = agentURI;
        emit Registered(agentId, agentURI, msg.sender);
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        owner = owners[agentId];
        require(owner != address(0), "ERC721: invalid token ID");
    }
}
