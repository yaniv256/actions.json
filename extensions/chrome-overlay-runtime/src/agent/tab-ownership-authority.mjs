export async function claimTabWithDurableAuthority({
  authority,
  groupId,
  lease,
  persistMetadata,
  rollbackMetadata = async () => true,
  connect,
}) {
  if (
    typeof authority?.claimTabWithReceipt !== "function"
    || typeof authority?.rollbackTabClaim !== "function"
  ) {
    throw new Error("A compare-and-swap durable tab ownership authority is required");
  }
  if (typeof persistMetadata !== "function" || typeof connect !== "function") {
    throw new Error("Tab metadata persistence and connect callbacks are required");
  }

  const receipt = await authority.claimTabWithReceipt(groupId, lease);
  const claimedLease = receipt.claimedLease;
  let metadataPersisted = false;
  try {
    metadataPersisted = await persistMetadata(claimedLease);
    if (metadataPersisted !== true) {
      throw new Error("Secondary tab metadata did not persist");
    }
  } catch (error) {
    try {
      if (await authority.rollbackTabClaim(receipt) !== true) {
        throw new Error("Durable tab claim was superseded before compensation");
      }
      if (await rollbackMetadata(claimedLease) !== true) {
        throw new Error("Secondary tab metadata was superseded before compensation");
      }
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Tab claim failed and its durable ownership outcome is unavailable",
      );
    }
    throw error;
  }

  await connect(claimedLease);
  return claimedLease;
}
