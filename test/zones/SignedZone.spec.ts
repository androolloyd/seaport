import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { keccak256, recoverAddress, toUtf8Bytes } from "ethers/lib/utils";
import hre, { ethers, network } from "hardhat";

import {
  SIP5Interface__factory,
  ZoneInterface__factory,
} from "../../typechain-types";
import { merkleTree } from "../utils/criteria";
import {
  buildResolver,
  convertSignatureToEIP2098,
  getInterfaceID,
  getItemETH,
  randomHex,
  toBN,
  toKey,
} from "../utils/encoding";
import { faucet } from "../utils/faucet";
import { seaportFixture } from "../utils/fixtures";
import {
  VERSION,
  changeChainId,
  getCustomRevertSelector,
} from "../utils/helpers";

import type {
  ConsiderationInterface,
  SignedZone,
  SignedZoneCaptain,
  SignedZoneController,
} from "../../typechain-types";
import type { SeaportFixtures } from "../utils/fixtures";
import type { Contract, Wallet } from "ethers";

const { signedOrderType } = require("../../eip-712-types/signedOrder");

const { parseEther } = ethers.utils;

describe(`Zone - SignedZone (Seaport v${VERSION})`, function () {
  if (process.env.REFERENCE) return;

  const { provider } = ethers;
  const owner = new ethers.Wallet(randomHex(32), provider);
  const rotator = new ethers.Wallet(randomHex(32), provider);
  const pauser = new ethers.Wallet(randomHex(32), provider);

  // Salt for the signed zone deployment
  const salt = `0x${owner.address.slice(2)}000000000000000000000000`;

  // Version byte for SIP-6 using Substandard 1
  const sip6VersionByte = "00";

  let marketplaceContract: ConsiderationInterface;
  let signedZone: SignedZone;
  let signedZoneController: SignedZoneController;
  let signedZoneCaptain: SignedZoneCaptain;

  let checkExpectedEvents: SeaportFixtures["checkExpectedEvents"];
  let createOrder: SeaportFixtures["createOrder"];
  let getTestItem721: SeaportFixtures["getTestItem721"];
  let getTestItem721WithCriteria: SeaportFixtures["getTestItem721WithCriteria"];
  let mintAndApprove721: SeaportFixtures["mintAndApprove721"];
  let withBalanceChecks: SeaportFixtures["withBalanceChecks"];

  after(async () => {
    await network.provider.request({
      method: "hardhat_reset",
    });
  });

  before(async () => {
    // Setup basic owner/rotator/pauser wallets with ETH
    const faucetList = [owner, rotator, pauser];
    for (const wallet of faucetList) {
      await faucet(wallet.address, provider);
    }

    ({
      checkExpectedEvents,
      createOrder,
      getTestItem721,
      getTestItem721WithCriteria,
      marketplaceContract,
      mintAndApprove721,
      withBalanceChecks,
    } = await seaportFixture(owner));
  });

  let buyer: Wallet;
  let seller: Wallet;

  let approvedSigner: Wallet;
  let chainId: number;

  beforeEach(async () => {
    // Setup basic buyer/seller and approvedSigner wallets with ETH
    seller = new ethers.Wallet(randomHex(32), provider);
    buyer = new ethers.Wallet(randomHex(32), provider);
    approvedSigner = new ethers.Wallet(randomHex(32), provider);

    for (const wallet of [seller, buyer, approvedSigner]) {
      await faucet(wallet.address, provider);
    }

    chainId = (await provider.getNetwork()).chainId;

    const documentationURI =
      "https://github.com/ProjectOpenSea/SIPs/blob/main/SIPS/sip-7.md";

    const signedZoneControllerFactory = await ethers.getContractFactory(
      "SignedZoneController",
      owner
    );
    signedZoneController = await signedZoneControllerFactory.deploy();

    // Deploy the signed zone captain.
    const SignedZoneCaptainFactory = await ethers.getContractFactory(
      "SignedZoneCaptain",
      owner
    );
    signedZoneCaptain = await SignedZoneCaptainFactory.deploy(
      signedZoneController.address,
      owner.address,
      rotator.address,
      pauser.address
    );

    signedZoneController
      .connect(owner)
      .createZone(
        "OpenSeaSignedZone",
        "https://api.opensea.io/api/v2/sign",
        documentationURI,
        signedZoneCaptain.address,
        salt
      );

    // Get the address of the signed zone
    const signedZoneAddress = await signedZoneController.getZone(salt);

    // Attach to the signed zone
    signedZone = (await ethers.getContractAt(
      "SignedZone",
      signedZoneAddress,
      owner
    )) as SignedZone;
  });

  const toPaddedBytes = (value: number, numBytes = 32) =>
    ethers.BigNumber.from(value)
      .toHexString()
      .slice(2)
      .padStart(numBytes * 2, "0");

  const calculateSignedOrderHash = (
    fulfiller: string,
    expiration: number,
    orderHash: string,
    context: string
  ) => {
    const signedOrderTypeString =
      "SignedOrder(address fulfiller,uint64 expiration,bytes32 orderHash,bytes context)";
    const signedOrderTypeHash = keccak256(toUtf8Bytes(signedOrderTypeString));

    const signedOrderHash = keccak256(
      "0x" +
        [
          signedOrderTypeHash.slice(2),
          fulfiller.slice(2).padStart(64, "0"),
          toPaddedBytes(expiration),
          orderHash.slice(2),
          keccak256(context).slice(2),
        ].join("")
    );

    return signedOrderHash;
  };

  const signOrder = async (
    orderHash: string,
    context: string = "0x",
    signer: Wallet,
    fulfiller = ethers.constants.AddressZero,
    secondsUntilExpiration = 200,
    zone: Contract = signedZone
  ) => {
    const domainData = {
      name: "SignedZone",
      version: "1.0",
      chainId,
      verifyingContract: zone.address,
    };

    const expiration = Math.round(Date.now() / 1000) + secondsUntilExpiration;
    const signedOrder = { fulfiller, expiration, orderHash, context };
    let signature = await signer._signTypedData(
      domainData,
      signedOrderType,
      signedOrder
    );

    signature = convertSignatureToEIP2098(signature);
    expect(signature.length).to.eq(2 + 64 * 2); // 0x + 64 bytes

    // Get the domain separator by decoding the Seaport Metadata
    const seaportMetadata = await zone.getSeaportMetadata();
    // Decode the metadata
    const decodedMetadata = ethers.utils.defaultAbiCoder.decode(
      [
        "bytes32 domainSeparator",
        "string apiEndpoint",
        "uint256[] substandards",
        "string documentationURI",
      ],
      seaportMetadata[1][0][1]
    );

    // Get the domain separator
    const domainSeparator = decodedMetadata.domainSeparator;

    const signedOrderHash = calculateSignedOrderHash(
      fulfiller,
      expiration,
      orderHash,
      context
    );
    const digest = keccak256(
      `0x1901${domainSeparator.slice(2)}${signedOrderHash.slice(2)}`
    );

    const recoveredAddress = recoverAddress(digest, signature);
    expect(recoveredAddress).to.equal(signer.address);

    // extraData to be set on the order, according to SIP-7
    const extraData = `0x${sip6VersionByte}${fulfiller.slice(2)}${toPaddedBytes(
      expiration,
      8
    )}${signature.slice(2)}${context.slice(2)}`;

    return { signature, expiration, extraData };
  };

  it("Fulfills an order with a signed zone", async () => {
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
      getItemETH(parseEther("1"), parseEther("1"), approvedSigner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    const substandard1Data = `0x${sip6VersionByte}${toPaddedBytes(
      consideration[0].identifierOrCriteria.toNumber()
    ).toString()}`;

    order.extraData = (
      await signOrder(orderHash, substandard1Data, approvedSigner)
    ).extraData;

    // Expect failure if signer is not approved
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "SignerNotActive")
      .withArgs(approvedSigner.address, orderHash);

    // Approve signer
    await signedZoneCaptain.updateZoneSigner(
      signedZone.address,
      approvedSigner.address,
      true
    );

    // Expect success now that signer is approved
    await withBalanceChecks([order], 0, undefined, async () => {
      const tx = await marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        );

      const receipt = await tx.wait();
      await checkExpectedEvents(tx, receipt, [
        {
          order,
          orderHash,
          fulfiller: buyer.address,
          fulfillerConduitKey: toKey(0),
        },
      ]);
      return receipt;
    });
  });
  it("Fulfills an order with a signed zone for a specific fulfiller only", async () => {
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    // Get the substandard1 data
    const substandard1Data = `0x${sip6VersionByte}${toPaddedBytes(
      consideration[0].identifierOrCriteria.toNumber()
    ).toString()}`;

    order.extraData = (
      await signOrder(
        orderHash,
        substandard1Data,
        approvedSigner,
        buyer.address
      )
    ).extraData;

    // Approve signer
    await signedZoneCaptain.updateZoneSigner(
      signedZone.address,
      approvedSigner.address,
      true
    );

    // Expect failure if fulfiller does not match
    await expect(
      marketplaceContract
        .connect(owner)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "InvalidFulfiller")
      .withArgs(buyer.address, owner.address, orderHash);

    // Expect success with correct fulfiller
    await withBalanceChecks([order], 0, undefined, async () => {
      const tx = await marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        );

      const receipt = await tx.wait();
      await checkExpectedEvents(tx, receipt, [
        {
          order,
          orderHash,
          fulfiller: buyer.address,
          fulfillerConduitKey: toKey(0),
        },
      ]);
      return receipt;
    });
  });
  it("Fulfills an advanced order with criteria with a signed zone", async () => {
    // Create advanced order using signed zone
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const { root, proofs } = merkleTree([nftId]);

    const offer = [getTestItem721WithCriteria(root, toBN(1), toBN(1))];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const criteriaResolvers = [
      buildResolver(0, 0, 0, nftId, proofs[nftId.toString()]),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2, // FULL_RESTRICTED
      criteriaResolvers
    );

    // Get the substandard1 data
    const substandard1Data = `0x${sip6VersionByte}${toPaddedBytes(
      consideration[0].identifierOrCriteria.toNumber()
    ).toString()}`;

    order.extraData = (
      await signOrder(orderHash, substandard1Data, approvedSigner)
    ).extraData;

    // Expect failure if signer is not approved
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          criteriaResolvers,
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "SignerNotActive")
      .withArgs(approvedSigner.address, orderHash);

    // Approve signer
    await signedZoneCaptain.updateZoneSigner(
      signedZone.address,
      approvedSigner.address,
      true
    );

    await withBalanceChecks([order], 0, criteriaResolvers, async () => {
      const tx = await marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          criteriaResolvers,
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        );

      const receipt = await tx.wait();
      await checkExpectedEvents(
        tx,
        receipt,
        [
          {
            order,
            orderHash,
            fulfiller: buyer.address,
            fulfillerConduitKey: toKey(0),
          },
        ],
        undefined,
        criteriaResolvers
      );
      return receipt;
    });
  });
  it("Does not fulfill an expired signature order with a signed zone", async () => {
    // Create advanced order using signed zone
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    // Approve signer
    await signedZoneCaptain.updateZoneSigner(
      signedZone.address,
      approvedSigner.address,
      true
    );

    // Get the substandard1 data
    const substandard1Data = `0x${sip6VersionByte}${toPaddedBytes(
      consideration[0].identifierOrCriteria.toNumber()
    ).toString()}`;

    const { extraData, expiration } = await signOrder(
      orderHash,
      substandard1Data,
      approvedSigner,
      undefined,
      -1000
    );
    order.extraData = extraData;

    // Expect failure that signature is expired
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "SignatureExpired")
      .withArgs(expiration, orderHash);

    // Tamper with extraData by extending the expiration
    order.extraData =
      order.extraData.slice(0, 50) + "9" + order.extraData.slice(51);

    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "SignerNotActive")
      .withArgs(anyValue, orderHash);
  });
  it("Transfer ownership of zones via a two-stage process", async () => {
    await expect(
      signedZoneCaptain
        .connect(buyer)
        .transferZoneOwnership(signedZone.address, buyer.address)
    ).to.be.revertedWithCustomError(signedZoneCaptain, "CallerIsNotOwner");

    await expect(
      signedZoneCaptain
        .connect(owner)
        .transferZoneOwnership(signedZone.address, ethers.constants.AddressZero)
    ).to.be.revertedWithCustomError(
      signedZoneController,
      "NewPotentialOwnerIsNullAddress"
    );

    await expect(
      signedZoneCaptain
        .connect(owner)
        .transferZoneOwnership(seller.address, buyer.address)
    ).to.be.revertedWithCustomError(signedZoneController, "NoZone");

    let potentialOwner = await signedZoneController.getPotentialOwner(
      signedZone.address
    );
    expect(potentialOwner).to.equal(ethers.constants.AddressZero);

    await signedZoneCaptain.transferZoneOwnership(
      signedZone.address,
      buyer.address
    );

    potentialOwner = await signedZoneController.getPotentialOwner(
      signedZone.address
    );
    expect(potentialOwner).to.equal(buyer.address);

    await expect(
      signedZoneCaptain
        .connect(owner)
        .transferZoneOwnership(signedZone.address, buyer.address)
    ).to.be.revertedWithCustomError(
      signedZoneController,
      "NewPotentialOwnerAlreadySet"
    );

    await expect(
      signedZoneCaptain
        .connect(buyer)
        .cancelZoneOwnershipTransfer(signedZone.address)
    ).to.be.revertedWithCustomError(signedZoneCaptain, "CallerIsNotOwner");

    await expect(
      signedZoneCaptain
        .connect(owner)
        .cancelZoneOwnershipTransfer(seller.address)
    ).to.be.revertedWithCustomError(signedZoneController, "NoZone");

    await signedZoneCaptain.cancelZoneOwnershipTransfer(signedZone.address);

    potentialOwner = await signedZoneController.getPotentialOwner(
      signedZone.address
    );
    expect(potentialOwner).to.equal(ethers.constants.AddressZero);

    await expect(
      signedZoneCaptain
        .connect(owner)
        .cancelZoneOwnershipTransfer(signedZone.address)
    ).to.be.revertedWithCustomError(
      signedZoneController,
      "NoPotentialOwnerCurrentlySet"
    );

    await signedZoneCaptain.transferZoneOwnership(
      signedZone.address,
      buyer.address
    );

    potentialOwner = await signedZoneController.getPotentialOwner(
      signedZone.address
    );
    expect(potentialOwner).to.equal(buyer.address);

    await expect(
      signedZoneController.connect(buyer).acceptOwnership(seller.address)
    ).to.be.revertedWithCustomError(signedZoneController, "NoZone");

    await expect(
      signedZoneController.connect(seller).acceptOwnership(signedZone.address)
    ).to.be.revertedWithCustomError(
      signedZoneController,
      "CallerIsNotNewPotentialOwner"
    );

    await signedZoneController
      .connect(buyer)
      .acceptOwnership(signedZone.address);

    potentialOwner = await signedZoneController.getPotentialOwner(
      signedZone.address
    );
    expect(potentialOwner).to.equal(ethers.constants.AddressZero);

    let ownerOf = await signedZoneController.ownerOf(signedZone.address);
    expect(ownerOf).to.equal(buyer.address);

    // Return ownership back to the captain
    await signedZoneController
      .connect(buyer)
      .transferOwnership(signedZone.address, signedZoneCaptain.address);

    // Accept ownership back
    await signedZoneCaptain.acceptZoneOwnership(signedZone.address);

    ownerOf = await signedZoneController.ownerOf(signedZone.address);
    expect(ownerOf).to.equal(signedZoneCaptain.address);
  });
  it("Transfer ownership of the captain via a two-stage process", async () => {
    await expect(
      signedZoneCaptain.connect(buyer).transferOwnership(buyer.address)
    ).to.be.revertedWithCustomError(signedZoneCaptain, "CallerIsNotOwner");

    await expect(
      signedZoneCaptain
        .connect(owner)
        .transferOwnership(ethers.constants.AddressZero)
    ).to.be.revertedWithCustomError(
      signedZoneCaptain,
      "NewPotentialOwnerIsNullAddress"
    );

    let potentialOwner = await signedZoneCaptain.potentialOwner();
    expect(potentialOwner).to.equal(ethers.constants.AddressZero);

    await signedZoneCaptain.transferOwnership(buyer.address);

    potentialOwner = await signedZoneCaptain.potentialOwner();
    expect(potentialOwner).to.equal(buyer.address);

    await expect(
      signedZoneCaptain.connect(owner).transferOwnership(buyer.address)
    ).to.be.revertedWithCustomError(
      signedZoneCaptain,
      "NewPotentialOwnerAlreadySet"
    );

    await expect(
      signedZoneCaptain.connect(buyer).cancelOwnershipTransfer()
    ).to.be.revertedWithCustomError(signedZoneCaptain, "CallerIsNotOwner");

    await signedZoneCaptain.cancelOwnershipTransfer();

    potentialOwner = await signedZoneCaptain.potentialOwner();
    expect(potentialOwner).to.equal(ethers.constants.AddressZero);

    await expect(
      signedZoneCaptain.connect(owner).cancelOwnershipTransfer()
    ).to.be.revertedWithCustomError(
      signedZoneCaptain,
      "NoPotentialOwnerCurrentlySet"
    );

    await signedZoneCaptain.transferOwnership(buyer.address);

    potentialOwner = await signedZoneCaptain.potentialOwner();
    expect(potentialOwner).to.equal(buyer.address);

    await expect(
      signedZoneCaptain.connect(seller).acceptOwnership()
    ).to.be.revertedWithCustomError(
      signedZoneCaptain,
      "CallerIsNotNewPotentialOwner"
    );

    await signedZoneCaptain.connect(buyer).acceptOwnership();

    potentialOwner = await signedZoneCaptain.potentialOwner();
    expect(potentialOwner).to.equal(ethers.constants.AddressZero);

    let ownerOf = await signedZoneCaptain.owner();
    expect(ownerOf).to.equal(buyer.address);

    // Return ownership back to the original owner
    await signedZoneCaptain.connect(buyer).transferOwnership(owner.address);

    // Accept ownership back
    await signedZoneCaptain.connect(owner).acceptOwnership();

    ownerOf = await signedZoneCaptain.owner();
    expect(ownerOf).to.equal(owner.address);
  });
  it("Reverts if the signedzone is sent unsupported function selector", async () => {
    const badCalldata = "0xdeadbeef";
    await expect(
      owner.sendTransaction({
        to: signedZone.address,
        data: badCalldata,
        value: 0x0,
        gasLimit: 100_000,
      })
    ).to.be.revertedWithCustomError(signedZone, "UnsupportedFunctionSelector");
  });
  it("Reverts if ZoneParameters has non-default offset", async () => {
    const invalidOffset =
      "0000000000000000000000000000000000000000000000000000000000000040";
    const badCalldata = `0x17b1f942${invalidOffset}708828409c1e58bcc2489de25353a5f6b3c5660a7433c33fc70d4c1b2e394e70000000000000000000000000274f1f39e5d5196ff617e008cdf28a56c0dc6273000000000000000000000000143e39ba12f034161ca094b8e68456e34f1c56b7000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000003e000000000000000000000000000000000000000000000000000000000000004800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ff00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000ed3de4fd37d11ecf83533b4abbe37e77f06a764400000000000000000000000000000000f1d494d5b82d5cf5324c53eb0fd3439e000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000143e39ba12f034161ca094b8e68456e34f1c56b70000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000cb3101ed5d6f99d94eef452da899a5e9c422499b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000017f26dc228f0f86e780811f4c3f3c2701ac990ae000000000000000000000000000000000000000000000000000000000000007e0000000000000000000000000000000000000000000000000063e3d0e0338ec31f0e9c2183000b63d5258ba7ec0bcfacf14e6fb938d49318cf10daa3bdb36a2fd7be1489f0051c74de64661c2f4fe825b56ee4140d7dbd7b16f0c99312000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000017b1f942`;

    // Directly call validateOrder on the signed zone
    await expect(
      owner.sendTransaction({
        to: signedZone.address,
        data: badCalldata,
        value: 0x0,
        gasLimit: 100_000,
      })
    ).to.be.revertedWithCustomError(signedZone, "InvalidZoneParameterEncoding");
  });
  it("Revert: Fulfills an order without the correct substandard version", async () => {
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    // Set incorrect version byte
    const incorrectVersionByte = "01";
    const substandard1Data = `0x${incorrectVersionByte}${toPaddedBytes(
      consideration[0].identifierOrCriteria.toNumber()
    ).toString()}`;

    order.extraData = (
      await signOrder(orderHash, substandard1Data, approvedSigner)
    ).extraData;

    // Approve signer
    await signedZoneCaptain.updateZoneSigner(
      signedZone.address,
      approvedSigner.address,
      true
    );

    // Expect failure
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "InvalidSubstandardVersion")
      .withArgs(orderHash);
  });
  it("Revert: Try to fulfill an order with an incorrect token identifier", async () => {
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    const expectedTokenID = 9999;
    const substandard1Data = `0x${sip6VersionByte}${toPaddedBytes(
      expectedTokenID
    ).toString()}`;

    order.extraData = (
      await signOrder(orderHash, substandard1Data, approvedSigner)
    ).extraData;

    // Approve signer
    await signedZoneCaptain.updateZoneSigner(
      signedZone.address,
      approvedSigner.address,
      true
    );

    // Expect failure if signer is not approved
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "InvalidReceivedItem")
      .withArgs(
        expectedTokenID,
        consideration[0].identifierOrCriteria,
        orderHash
      );
  });
  it("Revert: Try to fulfill an order with no considerations", async () => {
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      [],
      2 // FULL_RESTRICTED
    );

    const expectedTokenID = 1;
    const substandard1Data = `0x${sip6VersionByte}${toPaddedBytes(
      expectedTokenID
    ).toString()}`;

    order.extraData = (
      await signOrder(orderHash, substandard1Data, approvedSigner)
    ).extraData;

    // Approve signer
    await signedZoneCaptain.updateZoneSigner(
      signedZone.address,
      approvedSigner.address,
      true
    );

    // Expect failure if signer is not approved
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "InvalidSubstandardSupport")
      .withArgs("Consideration must have at least one item.", 1, orderHash);
  });
  it("Update the rotator of the signed zone captain", async () => {
    // Update the rotator without permission
    await expect(
      signedZoneCaptain.connect(buyer).updateRotator(buyer.address)
    ).to.be.revertedWithCustomError(signedZoneCaptain, "CallerIsNotOwner");

    // Update rotator with invalid address
    await expect(
      signedZoneCaptain
        .connect(owner)
        .updateRotator(ethers.constants.AddressZero)
    ).to.be.revertedWithCustomError(
      signedZoneCaptain,
      "RotatorCannotBeNullAddress"
    );

    // Update the rotator
    await signedZoneCaptain.connect(owner).updateRotator(buyer.address);

    expect(await signedZoneCaptain.getRotator()).to.equal(buyer.address);
  });
  it("Update the pauser of the signed zone captain", async () => {
    // Update the pauser without permission
    await expect(
      signedZoneCaptain.connect(buyer).updatePauser(buyer.address)
    ).to.be.revertedWithCustomError(signedZoneCaptain, "CallerIsNotOwner");

    // Update pauser with invalid address
    await expect(
      signedZoneCaptain
        .connect(owner)
        .updatePauser(ethers.constants.AddressZero)
    ).to.be.revertedWithCustomError(
      signedZoneCaptain,
      "PauserCannotBeNullAddress"
    );

    // Update the pauser
    await signedZoneCaptain.connect(owner).updatePauser(buyer.address);

    expect(await signedZoneCaptain.getPauser()).to.equal(buyer.address);
  });
  it("Revert: Try to deploy the Captain with a null address as initial owner.", async () => {
    const SignedZoneCaptainFactory = await ethers.getContractFactory(
      "SignedZoneCaptain",
      owner
    );

    await expect(
      SignedZoneCaptainFactory.deploy(
        signedZoneController.address,
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        { gasLimit: 10000000 }
      )
    ).to.be.revertedWithCustomError(
      signedZoneCaptain,
      "InitialOwnerIsNullAddress"
    );
  });
  it("Add multiple signers, then remove them", async () => {
    // Add multiple signers
    await signedZoneCaptain
      .connect(owner)
      .updateZoneSigner(signedZone.address, owner.address, true);
    await signedZoneCaptain
      .connect(owner)
      .updateZoneSigner(signedZone.address, buyer.address, true);
    await signedZoneCaptain
      .connect(owner)
      .updateZoneSigner(signedZone.address, seller.address, true);

    expect(
      await signedZoneController.isActiveSigner(
        signedZone.address,
        owner.address
      )
    ).to.equal(true);
    expect(
      await signedZoneController.isActiveSigner(
        signedZone.address,
        buyer.address
      )
    ).to.equal(true);
    expect(
      await signedZoneController.isActiveSigner(
        signedZone.address,
        seller.address
      )
    ).to.equal(true);

    // Remove multiple signers
    await signedZoneCaptain.updateZoneSigner(
      signedZone.address,
      buyer.address,
      false
    );

    expect(
      await signedZoneController.isActiveSigner(
        signedZone.address,
        owner.address
      )
    ).to.equal(true);
    expect(
      await signedZoneController.isActiveSigner(
        signedZone.address,
        buyer.address
      )
    ).to.equal(false);
    expect(
      await signedZoneController.isActiveSigner(
        signedZone.address,
        seller.address
      )
    ).to.equal(true);
  });
  it("Only the owner or rotator can set and remove signers", async () => {
    await expect(
      signedZoneController
        .connect(buyer)
        .updateSigner(signedZone.address, buyer.address, true)
    ).to.be.revertedWithCustomError(signedZoneController, "CallerIsNotOwner");

    await expect(
      signedZoneController
        .connect(buyer)
        .updateSigner(signedZone.address, buyer.address, false)
    ).to.be.revertedWithCustomError(signedZoneController, "CallerIsNotOwner");

    // Try to update the signer directly on the signed zone.
    // Create interface to decode the updateSigner result.
    const updateSignerABI = ["function updateSigner(address,bool)"];
    const updateSignerInterface = new ethers.utils.Interface(updateSignerABI);
    const updateSignerInputData = updateSignerInterface.encodeFunctionData(
      "updateSigner(address,bool)",
      [buyer.address, false]
    );

    // Expect to be returned the signature for InvalidController().
    // Below is the representation of what this expect should be testing.
    // await expect(
    //   signedZone.connect(owner).updateSigner(buyer.address, false)
    // ).to.be.revertedWithCustomError(signedZone, "InvalidController");
    expect(
      await provider.call({
        to: signedZone.address,
        data: updateSignerInputData,
      })
    ).to.be.eq("0x6d5769be");

    await expect(
      signedZoneCaptain
        .connect(owner)
        .updateZoneSigner(signedZone.address, approvedSigner.address, true)
    )
      .to.emit(signedZone, "SignerAdded")
      .withArgs(approvedSigner.address);

    // Check that the signer was added on the controller.
    expect(
      await signedZoneController.getActiveSigners(signedZone.address)
    ).to.deep.equal([approvedSigner.address]);

    // Create interface to decode the getActiveSigners result.
    const getActiveSignerABI = [
      "function getActiveSigners() returns (address[] signers)",
    ];
    const getActiveSignerInterface = new ethers.utils.Interface(
      getActiveSignerABI
    );
    const getActiveSignerInputData =
      getActiveSignerInterface.encodeFunctionData("getActiveSigners");

    // Check that the signer was added on the signed zone.
    expect(
      getActiveSignerInterface.decodeFunctionResult(
        "getActiveSigners",
        await provider.call({
          to: signedZone.address,
          data: getActiveSignerInputData,
        })
      )[0]
    ).to.deep.equal([approvedSigner.address]);

    await expect(
      signedZoneCaptain
        .connect(owner)
        .updateZoneSigner(signedZone.address, approvedSigner.address, true)
    )
      .to.be.revertedWithCustomError(signedZoneController, "SignerAlreadyAdded")
      .withArgs(approvedSigner.address);

    // The active signer should not be able to add other signers.
    await expect(
      signedZoneCaptain
        .connect(approvedSigner)
        .updateZoneSigner(signedZone.address, buyer.address, true)
    ).to.be.revertedWithCustomError(signedZoneCaptain, "CallerIsNotOwner");

    // The rotator should be able to add other signers, but be required to
    // remove an active signer first.

    await expect(
      signedZoneCaptain
        .connect(rotator)
        .rotateSigners(
          signedZone.address,
          approvedSigner.address,
          buyer.address
        )
    )
      .to.emit(signedZone, "SignerAdded")
      .withArgs(buyer.address);

    // We should have still only have one active signer.
    expect(
      await signedZoneController.getActiveSigners(signedZone.address)
    ).to.deep.equal([buyer.address]);
    // Check that the signers were rotated on the signed zone.
    expect(
      getActiveSignerInterface.decodeFunctionResult(
        "getActiveSigners",
        await provider.call({
          to: signedZone.address,
          data: getActiveSignerInputData,
        })
      )[0]
    ).to.deep.equal([buyer.address]);

    // The active signer should not be able remove other signers.
    await expect(
      signedZoneController
        .connect(approvedSigner)
        .updateSigner(signedZone.address, buyer.address, false)
    ).to.be.revertedWithCustomError(signedZoneController, "CallerIsNotOwner");

    // The captain owner should be able to remove other signers.
    await expect(
      signedZoneCaptain
        .connect(owner)
        .updateZoneSigner(signedZone.address, buyer.address, false)
    )
      .to.emit(signedZone, "SignerRemoved")
      .withArgs(buyer.address);

    // The active signer should be able to update API information.
    await expect(
      signedZoneController
        .connect(approvedSigner)
        .updateAPIEndpoint(signedZone.address, "test")
    ).to.be.revertedWithCustomError(signedZoneController, "CallerIsNotOwner");

    // The active signer should not be able to update the documentation URI.
    await expect(
      signedZoneController
        .connect(approvedSigner)
        .updateDocumentationURI(
          signedZone.address,
          "http://newDocumentationURI.com"
        )
    ).to.be.revertedWithCustomError(signedZoneController, "CallerIsNotOwner");

    // TODO: Determine how to allow the active signer to remove themselves.

    // The active signer should be able to remove themselves.
    // await expect(
    //   signedZoneController
    //     .connect(approvedSigner)
    //     .updateSigner(signedZone.address, approvedSigner.address, false)
    // )
    //   .to.emit(signedZone, "SignerRemoved")
    //   .withArgs(approvedSigner.address);

    // expect(
    //   await signedZoneController.getActiveSigners(signedZone.address)
    // ).to.deep.equal([]);
    // // Check that signers were removed.
    // expect(
    //   getActiveSignerInterface.decodeFunctionResult(
    //     "getActiveSigners",
    //     await provider.call({
    //       to: signedZone.address,
    //       data: getActiveSignerInputData,
    //     })
    //   )[0]
    // ).to.deep.equal([]);

    await expect(
      signedZoneCaptain
        .connect(owner)
        .updateZoneSigner(signedZone.address, approvedSigner.address, true)
    )
      .to.be.revertedWithCustomError(
        signedZoneController,
        "SignerCannotBeReauthorized"
      )
      .withArgs(approvedSigner.address);

    await expect(
      signedZoneCaptain
        .connect(owner)
        .updateZoneSigner(signedZone.address, approvedSigner.address, false)
    )
      .to.be.revertedWithCustomError(signedZoneController, "SignerNotPresent")
      .withArgs(approvedSigner.address);

    await expect(
      signedZoneCaptain
        .connect(owner)
        .updateZoneSigner(
          signedZone.address,
          ethers.constants.AddressZero,
          true
        )
    ).to.be.revertedWithCustomError(
      signedZoneController,
      "SignerCannotBeNullAddress"
    );

    await expect(
      signedZoneCaptain
        .connect(owner)
        .updateZoneSigner(signedZone.address, rotator.address, false)
    )
      .to.be.revertedWithCustomError(signedZoneController, "SignerNotPresent")
      .withArgs(rotator.address);

    expect(
      await signedZoneController.getActiveSigners(signedZone.address)
    ).to.deep.equal([]);
  });
  it("Pauser should be able to pause the zone.", async () => {
    // Try to pause the zone without permission.
    await expect(
      signedZoneCaptain.connect(buyer).pauseSignedZone(signedZone.address)
    ).to.be.revertedWithCustomError(
      signedZoneCaptain,
      "CallerIsNotOwnerOrPauser"
    );

    // Add a signer to the zone.
    const newSigner = new ethers.Wallet(randomHex(32), provider);
    await expect(
      signedZoneCaptain
        .connect(owner)
        .updateZoneSigner(signedZone.address, newSigner.address, true)
    )
      .to.emit(signedZone, "SignerAdded")
      .withArgs(newSigner.address);

    // Expect active signers to be the new signer.
    expect(
      await signedZoneController.getActiveSigners(signedZone.address)
    ).to.deep.equal([newSigner.address]);

    // Confirm that the rotator is set.
    expect(await signedZoneCaptain.getRotator()).to.be.eq(rotator.address);

    // Pause the zone
    await expect(
      signedZoneCaptain.connect(pauser).pauseSignedZone(signedZone.address)
    ).to.emit(signedZoneCaptain, "ZonePaused");

    // Expect active signers to be empty.
    expect(
      await signedZoneController.getActiveSigners(signedZone.address)
    ).to.deep.equal([]);

    // Expect rotator to be cleared.
    expect(await signedZoneCaptain.getRotator()).to.be.eq(
      ethers.constants.AddressZero
    );
  });
  it("Rotator should be able to rotate signers.", async () => {
    // Try to rotate signers without permission.
    await expect(
      signedZoneCaptain
        .connect(buyer)
        .rotateSigners(
          signedZone.address,
          approvedSigner.address,
          buyer.address
        )
    ).to.be.revertedWithCustomError(
      signedZoneCaptain,
      "CallerIsNotOwnerOrRotator"
    );

    // Add a signer to the zone.
    const firstSigner = new ethers.Wallet(randomHex(32), provider);
    await expect(
      signedZoneCaptain
        .connect(owner)
        .updateZoneSigner(signedZone.address, firstSigner.address, true)
    )
      .to.emit(signedZone, "SignerAdded")
      .withArgs(firstSigner.address);

    // Expect active signers to be the new signer.
    expect(
      await signedZoneController.getActiveSigners(signedZone.address)
    ).to.deep.equal([firstSigner.address]);

    const secondSigner = new ethers.Wallet(randomHex(32), provider);

    // Try to rotate signers with invalid signers.
    const invalidSigner = new ethers.Wallet(randomHex(32), provider);
    await expect(
      signedZoneCaptain
        .connect(rotator)
        .rotateSigners(
          signedZone.address,
          invalidSigner.address,
          secondSigner.address
        )
    )
      .to.be.revertedWithCustomError(signedZoneController, "SignerNotPresent")
      .withArgs(invalidSigner.address);

    // Rotate the signers.
    await expect(
      signedZoneCaptain
        .connect(rotator)
        .rotateSigners(
          signedZone.address,
          firstSigner.address,
          secondSigner.address
        )
    )
      .to.emit(signedZone, "SignerRemoved")
      .withArgs(firstSigner.address)
      .to.emit(signedZone, "SignerAdded")
      .withArgs(secondSigner.address);

    // Expect active signers to be the second signer.
    expect(
      await signedZoneController.getActiveSigners(signedZone.address)
    ).to.deep.equal([secondSigner.address]);
  });
  it("Create a zone setting initial owner not as caller.", async () => {
    const newSalt = `0x${owner.address.slice(2)}000000000000000000000099`;

    const testSignedZoneOwner = new ethers.Wallet(randomHex(32), provider);
    await signedZoneController
      .connect(owner)
      .createZone(
        "OpenSeaSignedZone",
        "https://api.opensea.io/api/v2/sign",
        "https://github.com/ProjectOpenSea/SIPs/blob/main/SIPS/sip-7.md",
        testSignedZoneOwner.address,
        newSalt
      );

    // Get the address of the signed zone
    const newSignedZoneAddress = await signedZoneController.getZone(newSalt);

    // Check the owner of the newly created zone.
    expect(await signedZoneController.ownerOf(newSignedZoneAddress)).to.be.eq(
      testSignedZoneOwner.address
    );
  });
  it("Revert: Try to create the zone with a previously used salt", async () => {
    await expect(
      signedZoneController
        .connect(owner)
        .createZone(
          "OpenSeaSignedZone",
          "https://api.opensea.io/api/v2/sign",
          "https://github.com/ProjectOpenSea/SIPs/blob/main/SIPS/sip-7.md",
          owner.address,
          salt
        )
    ).to.be.revertedWithCustomError(signedZoneController, "ZoneAlreadyExists");
  });
  it("Revert: Try to create the zone with an invalid creator", async () => {
    const newSalt = `0x${owner.address.slice(2)}000000000000000000000000`;

    // Try to create a zone with a salt that is not matching the caller.
    await expect(
      signedZoneController
        .connect(buyer)
        .createZone(
          "OpenSeaSignedZone",
          "https://api.opensea.io/api/v2/sign",
          "https://github.com/ProjectOpenSea/SIPs/blob/main/SIPS/sip-7.md",
          owner.address,
          newSalt
        )
    ).to.be.revertedWithCustomError(signedZoneController, "InvalidCreator");
  });
  it("Revert: Try to create the zone with an invalid initial owner", async () => {
    const newSalt =
      "0x0000000000000000000000000000000000000000000000000000000000001337";

    // Try to create a zone with null address as owner.
    await expect(
      signedZoneController
        .connect(buyer)
        .createZone(
          "OpenSeaSignedZone",
          "https://api.opensea.io/api/v2/sign",
          "https://github.com/ProjectOpenSea/SIPs/blob/main/SIPS/sip-7.md",
          ethers.constants.AddressZero,
          newSalt
        )
    ).to.be.revertedWithCustomError(
      signedZoneController,
      "InvalidInitialOwner"
    );
  });
  it("Revert: Try to create a signed zone captain with an invalid controller", async () => {
    const SignedZoneCaptainFactory = await ethers.getContractFactory(
      "SignedZoneCaptain",
      owner
    );

    await expect(
      SignedZoneCaptainFactory.deploy(
        owner.address,
        owner.address,
        rotator.address,
        pauser.address,
        { gasLimit: 500_000 }
      )
    )
      .to.be.revertedWithCustomError(
        signedZoneCaptain,
        "InvalidSignedZoneController"
      )
      .withArgs(owner.address);
  });
  it("Only the owner should be able to modify the apiEndpoint", async () => {
    expect(
      (
        await signedZoneController.getAdditionalZoneInformation(
          signedZone.address
        )
      )[2]
    ).to.equal("https://api.opensea.io/api/v2/sign");

    await expect(
      signedZoneController
        .connect(buyer)
        .updateAPIEndpoint(signedZone.address, "test123")
    ).to.be.revertedWithCustomError(signedZoneController, "CallerIsNotOwner");

    await signedZoneCaptain
      .connect(owner)
      .updateZoneAPIEndpoint(signedZone.address, "test123");

    expect(
      (
        await signedZoneController.getAdditionalZoneInformation(
          signedZone.address
        )
      )[2]
    ).to.eq("test123");
  });
  it("Only the owner should be able to modify the documentationURI", async () => {
    expect(
      (
        await signedZoneController.getAdditionalZoneInformation(
          signedZone.address
        )
      )[4]
    ).to.equal(
      "https://github.com/ProjectOpenSea/SIPs/blob/main/SIPS/sip-7.md"
    );

    await expect(
      signedZoneController
        .connect(buyer)
        .updateDocumentationURI(signedZone.address, "http://test.com")
    ).to.be.revertedWithCustomError(signedZoneController, "CallerIsNotOwner");

    await signedZoneCaptain
      .connect(owner)
      .updateZoneDocumentationURI(signedZone.address, "http://test.com");

    expect(
      (
        await signedZoneController.getAdditionalZoneInformation(
          signedZone.address
        )
      )[4]
    ).to.eq("http://test.com");
  });
  it("Getters for SignedZoneCaptain", async () => {
    expect(await signedZoneCaptain.getPauser()).to.eq(pauser.address);
    expect(await signedZoneCaptain.getRotator()).to.eq(rotator.address);
    expect(await signedZoneCaptain.owner()).to.eq(owner.address);
  });
  it("Should return valid data in sip7Information() and getSeaportMetadata()", async () => {
    const information = await signedZoneController.getAdditionalZoneInformation(
      signedZone.address
    );
    expect(information[0].length).to.eq(66);
    expect(information[1]).to.eq("OpenSeaSignedZone");
    expect(information[2]).to.eq("https://api.opensea.io/api/v2/sign");
    expect(information[3]).to.deep.eq([1].map((s) => toBN(s)));
    expect(information[4]).to.eq(
      "https://github.com/ProjectOpenSea/SIPs/blob/main/SIPS/sip-7.md"
    );

    const seaportMetadata = await signedZone.getSeaportMetadata();
    expect(seaportMetadata[0]).to.eq("OpenSeaSignedZone");
    expect(seaportMetadata[1][0][0]).to.deep.eq(toBN(7));

    // Get the domain separator
    const { domainSeparator, apiEndpoint, substandards, documentationURI } =
      await signedZoneController.getAdditionalZoneInformation(
        signedZone.address
      );

    // Create the expected metadata params
    const expectedSeaportMetadata = [
      domainSeparator,
      apiEndpoint,
      substandards,
      documentationURI,
    ];

    // Encode the expected metadata
    const expectedMetadataBytes = ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "string", "uint256[]", "string"],
      expectedSeaportMetadata
    );
    // Compare the encoded metadata to the one returned by the contract
    expect(seaportMetadata[1][0][1]).to.deep.eq(expectedMetadataBytes);

    // Decode the metadata
    const decodedMetadata = ethers.utils.defaultAbiCoder.decode(
      [
        "bytes32 domainSeparator",
        "string apiEndpoint",
        "uint256[] substandards",
        "string documentationURI",
      ],
      seaportMetadata[1][0][1]
    );
    // Compare the decoded metadata to the one returned by the contract
    expect(decodedMetadata).to.deep.eq(expectedSeaportMetadata);
  });
  it("Should error on improperly formatted extraData", async () => {
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    const substandard1Data = `0x${sip6VersionByte}${toPaddedBytes(
      consideration[0].identifierOrCriteria.toNumber()
    ).toString()}`;

    const validExtraData = (
      await signOrder(orderHash, substandard1Data, approvedSigner)
    ).extraData;

    // Approve signer
    await signedZoneCaptain.updateZoneSigner(
      signedZone.address,
      approvedSigner.address,
      true
    );

    // Expect failure with 0 length extraData
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "InvalidExtraDataLength")
      .withArgs(orderHash);

    // Expect failure with invalid length extraData
    order.extraData = validExtraData.slice(0, 50);
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "InvalidExtraDataLength")
      .withArgs(orderHash);

    // Expect failure with non-zero SIP-6 version byte
    order.extraData = "0x" + "01" + validExtraData.slice(4);
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "InvalidSIP6Version")
      .withArgs(orderHash);

    // Expect success with valid extraData
    order.extraData = validExtraData;
    await marketplaceContract
      .connect(buyer)
      .fulfillAdvancedOrder(order, [], toKey(0), ethers.constants.AddressZero, {
        value,
      });
  });
  it("Should return supportsInterface=true for ERC-165, SIP-5 and ZoneInterface", async () => {
    const supportedInterfacesSIP5Interface = [[SIP5Interface__factory]];
    const supportedInterfacesZoneInterface = [[ZoneInterface__factory]];

    // Create interface to decode the supportsInterface result.
    const supportsInterfaceABI = [
      "function supportsInterface(bytes4 interfaceId) returns (bool)",
    ];
    const iface = new ethers.utils.Interface(supportsInterfaceABI);

    for (const factories of [
      ...supportedInterfacesSIP5Interface,
      ...supportedInterfacesZoneInterface,
    ]) {
      const interfaceId = factories
        .map((factory) => getInterfaceID(factory.createInterface()))
        .reduce((prev, curr) => prev.xor(curr))
        .toHexString();
      const inputData = iface.encodeFunctionData("supportsInterface(bytes4)", [
        interfaceId,
      ]);

      expect(
        iface.decodeFunctionResult(
          "supportsInterface(bytes4)",
          await provider.call({
            to: signedZone.address,
            data: inputData,
          })
        )[0]
      ).to.be.true;
    }

    // Ensure the interface for ERC-165 returns true.
    const inputData = iface.encodeFunctionData("supportsInterface(bytes4)", [
      "0x01ffc9a7",
    ]);

    expect(
      iface.decodeFunctionResult(
        "supportsInterface(bytes4)",
        await provider.call({
          to: signedZone.address,
          data: inputData,
        })
      )[0]
    ).to.be.true;

    // Ensure invalid interfaces return false.
    const invalidInterfaceIds = ["0x00000000", "0x10000000", "0x00000001"];
    for (const interfaceId of invalidInterfaceIds) {
      const inputData = iface.encodeFunctionData("supportsInterface(bytes4)", [
        interfaceId,
      ]);

      expect(
        iface.decodeFunctionResult(
          "supportsInterface(bytes4)",
          await provider.call({
            to: signedZone.address,
            data: inputData,
          })
        )[0]
      ).to.be.false;
    }
  });
  // Note: Run this test last in this file as it hacks changing the hre
  it.skip("Reverts on changed chainId", async () => {
    // Create advanced order using signed zone
    // Execute 721 <=> ETH order
    const nftId = await mintAndApprove721(seller, marketplaceContract.address);

    const offer = [getTestItem721(nftId)];

    const consideration = [
      getItemETH(parseEther("10"), parseEther("10"), seller.address),
      getItemETH(parseEther("1"), parseEther("1"), owner.address),
    ];

    const { order, orderHash, value } = await createOrder(
      seller,
      signedZone.address,
      offer,
      consideration,
      2 // FULL_RESTRICTED
    );

    const substandard1Data = `0x${sip6VersionByte}${toPaddedBytes(
      consideration[0].identifierOrCriteria.toNumber()
    ).toString()}`;

    order.extraData = (
      await signOrder(orderHash, substandard1Data, approvedSigner)
    ).extraData;

    // Expect failure if signer is not approved
    await expect(
      marketplaceContract
        .connect(buyer)
        .fulfillAdvancedOrder(
          order,
          [],
          toKey(0),
          ethers.constants.AddressZero,
          {
            value,
          }
        )
    )
      .to.be.revertedWithCustomError(signedZone, "SignerNotActive")
      .withArgs(approvedSigner.address, orderHash);

    // Approve signer
    await signedZoneCaptain.updateZoneSigner(
      signedZone.address,
      approvedSigner.address,
      true
    );

    // TODO: Get to work on the signed zone, instead of failing on the marketplace.

    // Change chainId in-flight to test branch coverage for _deriveDomainSeparator()
    // (hacky way, until https://github.com/NomicFoundation/hardhat/issues/3074 is added)
    changeChainId(hre);

    const expectedRevertReason = getCustomRevertSelector("InvalidSigner()");

    const tx = await marketplaceContract
      .connect(buyer)
      .populateTransaction.fulfillAdvancedOrder(
        order,
        [],
        toKey(0),
        ethers.constants.AddressZero,
        {
          value,
        }
      );
    tx.chainId = 1;
    const returnData = await provider.call(tx);
    expect(returnData).to.equal(expectedRevertReason);
  });
});
