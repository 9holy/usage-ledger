import i18n from '@/i18n'

const errors: Record<string, string> = {
  'Handle or void the active linked events before voiding their source': 'financeLinkedBeforeVoid',
  'Termination loss exceeds the remaining prepaid balance at its business time': 'financeLossExceedsBalance',
  'Refund exceeds the unrefunded termination loss': 'financeRefundExceedsLoss',
  'Cumulative refunds exceed the original purchase payment': 'financeRefundExceedsPayment',
  'Related event is missing or voided; handle linked events first': 'financeRelatedUnavailable',
  'Related event must use the same scope, account and currency': 'financeRelatedIdentityMismatch',
  'Voided events cannot be edited': 'financeVoidedCannotEdit',
  'Event ownership cannot change; void and enter a new event': 'financeOwnerCannotChange',
  'Batch allocations must equal its paid total and share currency, time and channel; edit the whole batch': 'financeBatchMismatch',
}

export function financeErrorText(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure)
  return errors[message] ? i18n.global.t(`costComponents.${errors[message]}`) : message
}
