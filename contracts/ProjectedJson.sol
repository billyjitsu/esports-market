// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {JSONParserLib} from "solady/utils/JSONParserLib.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @title Reads fields of the JSON object that an Airnode v2 projection returns
/// @notice A response projection cuts a response down to a flat object, such as
/// {"price":2443.95,"updatedAt":1792403240691}. This library reads a top-level field of that object by its name.
/// Solady's JSONParserLib parses the JSON and finds the field, and this library adds reading decimal numbers with a
/// fixed number of decimal places.
/// @dev Verify the signature before you read the data. The signature is what makes sure that the data is the JSON that
/// the Airnode produced, with the fields that your projection asked for. Invalid JSON reverts with
/// JSONParserLib.ParsingFailed.
library ProjectedJson {
    using JSONParserLib for JSONParserLib.Item;

    error FieldNotFound(string key);
    error UnexpectedValue(string key);

    /// @notice Reads a number that is not negative, with `decimals` decimal places
    /// @dev Digits after `decimals` decimal places are cut off, so 2443.959 with 2 decimals reads as 244395. The
    /// Airnode signs numbers as JavaScript doubles, which keep about 15 significant digits. For a larger value that
    /// must be exact, such as an amount in wei, project a field that the API sends as a string.
    /// @param json The signed data
    /// @param key Field name, as written in the JSON
    /// @param decimals Number of decimal places in the result, so 18 reads 2443.95 as 2443950000000000000000
    function readUint(bytes memory json, string memory key, uint8 decimals) internal pure returns (uint256) {
        (bool isNegative, uint256 magnitude) = readNumber(json, key, decimals);
        if (isNegative) revert UnexpectedValue(key);
        return magnitude;
    }

    /// @notice Reads a number that can be negative, with `decimals` decimal places
    /// @dev Digits after `decimals` decimal places are cut off toward zero, so -1.239 with 2 decimals reads as -123.
    function readInt(bytes memory json, string memory key, uint8 decimals) internal pure returns (int256) {
        (bool isNegative, uint256 magnitude) = readNumber(json, key, decimals);
        int256 value = SafeCast.toInt256(magnitude);
        return isNegative ? -value : value;
    }

    function readBool(bytes memory json, string memory key) internal pure returns (bool) {
        JSONParserLib.Item memory item = findValue(json, key);
        if (!item.isBoolean()) revert UnexpectedValue(key);
        return LibString.eq(item.value(), "true");
    }

    /// @notice Reads a string, with its escape sequences decoded, so the value "say \"hi\"" reads as say "hi"
    function readString(bytes memory json, string memory key) internal pure returns (string memory) {
        JSONParserLib.Item memory item = findValue(json, key);
        if (!item.isString()) revert UnexpectedValue(key);
        return JSONParserLib.decodeString(item.value());
    }

    function findValue(bytes memory json, string memory key) private pure returns (JSONParserLib.Item memory item) {
        // JSONParserLib matches the key as it is written in the JSON, with its quotes.
        item = JSONParserLib.parse(string(json)).at(string.concat('"', key, '"'));
        if (item.isUndefined()) revert FieldNotFound(key);
    }

    /// @dev Reads a number written as -?digits(.digits)?. Exponent notation such as 1.2e-7 reverts with
    /// JSONParserLib.ParsingFailed.
    function readNumber(bytes memory json, string memory key, uint8 decimals)
        private
        pure
        returns (bool isNegative, uint256 magnitude)
    {
        JSONParserLib.Item memory item = findValue(json, key);
        if (!item.isNumber()) revert UnexpectedValue(key);

        string memory number = item.value();
        isNegative = bytes(number)[0] == "-";
        string memory unsignedNumber = isNegative ? LibString.slice(number, 1) : number;
        uint256 pointPosition = LibString.indexOf(unsignedNumber, ".");
        uint256 fractionDigitCount =
            pointPosition == LibString.NOT_FOUND ? 0 : bytes(unsignedNumber).length - pointPosition - 1;
        uint256 digits = JSONParserLib.parseUint(LibString.replace(unsignedNumber, ".", ""));
        magnitude = scaleToDecimals(digits, fractionDigitCount, decimals);
    }

    /// @dev Turns `digits`, of which the last `fractionDigitCount` are after the decimal point, into a value with
    /// `decimals` decimal places.
    function scaleToDecimals(uint256 digits, uint256 fractionDigitCount, uint8 decimals)
        private
        pure
        returns (uint256)
    {
        if (fractionDigitCount <= decimals) return digits * 10 ** (decimals - fractionDigitCount);
        uint256 cutDigitCount = fractionDigitCount - decimals;
        // A uint256 has at most 78 digits, so cutting more leaves nothing.
        return cutDigitCount >= 78 ? 0 : digits / 10 ** cutDigitCount;
    }
}
