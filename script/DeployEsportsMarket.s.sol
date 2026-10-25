// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {EsportsMarket} from "../contracts/EsportsMarket.sol";

contract DeployEsportsMarket is Script {
    // The PandaScore Airnode's address, from the x-airnode extension of the document at
    // https://airnode-pandascore.fly.dev/
    address constant PANDASCORE_AIRNODE = 0xd9D29FEDc3737aD5198611457fE04aB08a739C7b;

    function run() external returns (EsportsMarket market) {
        vm.broadcast(vm.envUint("PRIVATE_KEY"));
        market = new EsportsMarket(PANDASCORE_AIRNODE);
    }
}
