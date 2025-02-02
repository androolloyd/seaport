module.exports = {
  skipFiles: [
    "conduit/lib/ConduitEnums.sol",
    "conduit/lib/ConduitStructs.sol",
    "helpers/PointerLibraries.sol",
    "interfaces/AbridgedProxyInterfaces.sol",
    "interfaces/AbridgedTokenInterfaces.sol",
    "interfaces/ConduitControllerInterface.sol",
    "interfaces/ConduitInterface.sol",
    "interfaces/ConsiderationEventsAndErrors.sol",
    "interfaces/ConsiderationInterface.sol",
    "interfaces/ContractOffererInterface.sol",
    "interfaces/EIP1271Interface.sol",
    "interfaces/SeaportInterface.sol",
    "interfaces/ZoneInterface.sol",
    "lib/ConsiderationConstants.sol",
    "lib/ConsiderationEnums.sol",
    "lib/ConsiderationStructs.sol",
    "test/EIP1271Wallet.sol",
    "test/ExcessReturnDataRecipient.sol",
    "test/ERC1155BatchRecipient.sol",
    "test/InvalidEthRecipient.sol",
    "test/Reenterer.sol",
    "test/TestERC1155.sol",
    "test/TestERC1155Revert.sol",
    "test/TestERC20.sol",
    "test/TestERC20NotOk.sol",
    "test/TestERC721.sol",
    "test/TestERC721Revert.sol",
    "test/TestContractOfferer.sol",
    "test/TestContractOffererNativeToken.sol",
    "test/TestInvalidContractOfferer.sol",
    "test/TestInvalidContractOffererRatifyOrder.sol",
    "test/TestBadContractOfferer.sol",
    "test/TestPostExecution.sol",
    "test/TestZone.sol",
    "test/TestERC20Panic.sol",
    "test/TestERC20Revert.sol",
    "test/InvalidERC721Recipient.sol",
    "test/ERC721ReceiverMock.sol",
    "test/ConduitControllerMock.sol",
    "test/ConduitMock.sol",
    "test/ConduitMockErrors.sol",
    "test/ConduitMockInvalidMagic.sol",
    "test/ConduitMockRevertBytes.sol",
    "test/ConduitMockRevertNoReason.sol",
    "zones/PausableZone.sol",
    "zones/PausableZoneController.sol",
    "zones/interfaces/PausableZoneControllerInterface.sol",
    "zones/interfaces/PausableZoneEventsAndErrors.sol",
    "zones/interfaces/PausableZoneInterface.sol",
  ],
  configureYulOptimizer: true,
  solcOptimizerDetails: {
    yul: true,
    yulDetails: {
      stackAllocation: true,
    },
  },
};
