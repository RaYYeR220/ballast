// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {SessionOracle} from "../SessionOracle.sol";
import {BallastAccountBase} from "./BallastAccountBase.sol";
import {ListaAccount} from "./ListaAccount.sol";
import {MarketParams, IMoolah, IPcsV3SwapRouter, IComptroller, IVenusOracle} from "../interfaces/External.sol";

/// @title BallastFactory
/// @notice Creates per-user Ballast accounts (EIP-1167 clones) and keeps the registry the guardian checks.
contract BallastFactory is Ownable2Step {
    uint8 public constant VENUE_LISTA = 1;
    uint8 public constant VENUE_VENUS = 2;

    address public immutable listaImpl;
    SessionOracle public immutable sessionOracle;
    IMoolah public immutable moolah;
    IPcsV3SwapRouter public immutable router;
    IComptroller public immutable comptroller;
    IVenusOracle public immutable venusOracle;

    mapping(address => bool) public isAccount;
    mapping(address => address[]) internal _accountsOf;

    event AccountCreated(address indexed owner, address indexed account, uint8 venue, bytes32 symbol);

    constructor(
        address owner_,
        SessionOracle oracle_,
        IMoolah moolah_,
        IPcsV3SwapRouter router_,
        IComptroller comptroller_,
        IVenusOracle venusOracle_
    ) Ownable(owner_) {
        sessionOracle = oracle_;
        moolah = moolah_;
        router = router_;
        comptroller = comptroller_;
        venusOracle = venusOracle_;
        listaImpl = address(new ListaAccount());
    }

    function accountsOf(address owner_) external view returns (address[] memory) {
        return _accountsOf[owner_];
    }

    function createListaAccount(MarketParams calldata mp, bytes32 sym, address keeper, BallastAccountBase.Mandate calldata m)
        external
        returns (address account)
    {
        account = Clones.cloneDeterministic(listaImpl, _salt(msg.sender));
        ListaAccount(account).initialize(msg.sender, keeper, sym, sessionOracle, m, moolah, mp, router);
        _register(account, VENUE_LISTA, sym);
    }

    function _salt(address owner_) internal view returns (bytes32) {
        return keccak256(abi.encode(owner_, _accountsOf[owner_].length));
    }

    function _register(address account, uint8 venue, bytes32 sym) internal {
        isAccount[account] = true;
        _accountsOf[msg.sender].push(account);
        emit AccountCreated(msg.sender, account, venue, sym);
    }
}
