// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// @notice Single-writer, ordered evidence commitments. Development-chain prototype.
contract TrustAnchor {
    address public immutable writer;
    uint256 public count;
    bytes32 public head;
    mapping(uint256 => bytes32) public hashes;
    event Anchored(uint256 indexed sequence, bytes32 previous, bytes32 commitment);
    constructor() { writer = msg.sender; }
    function anchor(uint256 sequence, bytes32 previous, bytes32 commitment) external {
        require(msg.sender == writer, "WRITER_ONLY");
        require(sequence == count + 1, "SEQUENCE");
        require(previous == head, "PREVIOUS");
        require(commitment != bytes32(0), "EMPTY");
        count = sequence;
        head = commitment;
        hashes[sequence] = commitment;
        emit Anchored(sequence, previous, commitment);
    }
}
