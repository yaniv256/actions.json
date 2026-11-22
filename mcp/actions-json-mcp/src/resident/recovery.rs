use anyhow::Result;
use serde_json::Value;

use crate::state::{DurableOperationJournal, LifecycleState, OperationAcceptance, ReceiptState};

pub trait ReceiptOracle {
    fn receipt(&self, operation_id: &str) -> Result<(ReceiptState, Option<Value>)>;
}

pub trait ReplayValidator {
    /// Re-resolve stable target generation, catalog revision, and lease
    /// authority from the frozen acceptance. False leaves the operation
    /// accepted but undispatched for explicit recovery.
    fn still_authorized(&self, acceptance: &OperationAcceptance) -> Result<bool>;
}

pub trait ReplayDispatcher {
    /// Return success only after the extension durably records the operation
    /// identity and acknowledges that receipt.
    fn dispatch_with_receipt(
        &self,
        operation_id: &str,
        acceptance: &OperationAcceptance,
    ) -> Result<()>;
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RecoverySummary {
    pub replayed: Vec<String>,
    pub reconciled: Vec<String>,
    pub deferred: Vec<String>,
}

/// Reconcile extension receipts before replay. A mutation is replayed only
/// when the extension proves receipt absence and current target, catalog, and
/// lease authority all still validate. A received/started mutation is never
/// replayed; lack of a terminal receipt after dispatch remains indeterminate.
pub fn recover_accepted_operations(
    journal: &DurableOperationJournal,
    receipts: &dyn ReceiptOracle,
    validator: &dyn ReplayValidator,
    dispatcher: &dyn ReplayDispatcher,
) -> Result<RecoverySummary> {
    let mut summary = RecoverySummary::default();
    for (operation, acceptance) in journal.replayable()? {
        let (receipt, terminal) = receipts.receipt(&operation.operation_id)?;
        let state =
            journal.reconcile_receipt(&operation.operation_id, receipt, terminal.as_ref())?;
        if state != LifecycleState::AcceptedNotDispatched {
            summary.reconciled.push(operation.operation_id);
            continue;
        }
        if receipt != ReceiptState::Absent || !validator.still_authorized(&acceptance)? {
            summary.deferred.push(operation.operation_id);
            continue;
        }
        dispatcher.dispatch_with_receipt(&operation.operation_id, &acceptance)?;
        // `dispatch` means the extension accepted and durably recorded the
        // operation identity. We never mark dispatched merely for a local send.
        journal.mark_dispatched(&operation.operation_id)?;
        summary.replayed.push(operation.operation_id);
    }
    Ok(summary)
}
