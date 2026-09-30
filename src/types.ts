// types.ts - shapes shared across modules: what the beacon API returns, what
// the key files and keysets.json contain, and the report written to results/.

// ---------------------------------------------------------------------------
// Beacon node HTTP API (only the fields this tool reads).
// ---------------------------------------------------------------------------

// GET /eth/v1/node/syncing
export interface SyncingResponse {
    data: {
        head_slot?: string;
        sync_distance: string;
        is_syncing: boolean;
        is_optimistic?: boolean;
        el_offline?: boolean;
    };
}

// One entry of GET/POST /eth/v1/beacon/states/{state_id}/validators. All
// numbers arrive as decimal strings.
export interface ValidatorEntry {
    index: string;
    balance: string;
    status: string;
    validator: {
        pubkey: string;
        withdrawal_credentials: string;
        effective_balance: string;
        slashed?: boolean;
        activation_eligibility_epoch?: string;
        activation_epoch?: string;
        exit_epoch?: string;
        withdrawable_epoch?: string;
    };
}

export interface ValidatorsResponse {
    execution_optimistic?: boolean;
    finalized?: boolean;
    data?: ValidatorEntry[];
}

// One entry of GET /eth/v1/beacon/states/{state_id}/pending_deposits.
export interface PendingDeposit {
    pubkey: string;
    withdrawal_credentials?: string;
    amount: string;
    signature?: string;
    slot: string;
}

export interface PendingDepositsResponse {
    data?: PendingDeposit[];
}

// A pubkey's aggregate in the deposit queue. One key can have several
// deposits queued (initial deposit plus top-ups); position and gweiAhead
// refer to the first of them.
export interface QueuedDeposit {
    position: number;
    gweiAhead: number;
    amountGwei: number;
    deposits: number;
    slot: number;
}

export interface DepositQueue {
    byPubkey: Map<string, QueuedDeposit>;
    length: number;
    totalGwei: number;
}

export type ValidatorMap = Map<string, ValidatorEntry>;

// ---------------------------------------------------------------------------
// Key files and key sets.
// ---------------------------------------------------------------------------

export type KeySetType = 'cmv1' | 'cmv2';

// An entry in a key file. Only pubkey is required; anything else in the file
// is carried along untouched.
export interface KeyEntry {
    pubkey: string;
    genIndex?: number;
    [extra: string]: unknown;
}

// A key set as written in keysets.json (every field optional until
// normalised; keyJsonPath is the legacy alias of keyFile).
export interface RawKeySet {
    name?: string;
    slug?: string;
    type?: string;
    keyFile?: string;
    keyJsonPath?: string;
    chunkSize?: number | string;
    reportBatches?: unknown;
    perKeyCard?: unknown;
    webhookUrl?: string;
}

export interface KeySet {
    name: string;
    slug: string;
    type: KeySetType;
    keyFile: string;
    chunkSize: number;
    reportBatches: boolean;
    perKeyCard: boolean;
    webhookUrl: string;
}

// ---------------------------------------------------------------------------
// Reports.
// ---------------------------------------------------------------------------

export interface QueueInfo {
    position: number;
    ethAhead: number;
    estimatedWaitSeconds: number;
}

// Property order matters: it is the order the fields appear in the JSON
// report, so it must stay in step with buildKeyReport() in status.ts.
export interface KeyReport {
    pubkey: string;
    genIndex?: number;
    state: string;
    validatorIndex?: number;
    balanceEth?: number;
    effectiveBalanceEth?: number;
    credentials?: string | null;
    pendingTopUpEth?: number;
    queue?: QueueInfo;
    position?: number;
    batch?: string;
}

export interface Frontiers {
    lastDeposited: number;
    firstUndeposited: number;
    firstBelowCap: number;
    maxBalanceEth: number;
    hasActiveKeys: boolean;
}

export interface ReportTotals {
    keys: number;
    active: number;
    balanceTotalEth: number;
    balanceAvgEth: number;
    balanceMinEth: number;
    balanceMaxEth: number;
    pendingTopUpEth: number;
}

export interface Report {
    name: string;
    slug: string;
    type: KeySetType;
    perKeyCard: boolean;
    keyFile: string;
    endpoint: string;
    checkedAt: string;
    totals: ReportTotals;
    stateCounts: Record<string, number>;
    credentials: Record<string, number>;
    frontiers: Frontiers;
    // Only present (not undefined) for sets with reportBatches.
    batches: Record<string, number> | undefined;
    keys: KeyReport[];
}

// ---------------------------------------------------------------------------
// Adaptive Cards / Teams messages.
// ---------------------------------------------------------------------------

export interface Fact {
    title: string;
    value: string;
}

export interface CardSection {
    header?: string;
    facts: Fact[];
}

export interface TextBlock {
    type: 'TextBlock';
    text: string;
    wrap: boolean;
    color?: string;
    isSubtle?: boolean;
    weight?: string;
    size?: string;
    spacing?: string;
}

export interface FactSet {
    type: 'FactSet';
    facts: Fact[];
}

export type CardElement = TextBlock | FactSet;

export interface AdaptiveCard {
    type: 'AdaptiveCard';
    $schema: string;
    version: string;
    body: CardElement[];
}

export interface TeamsMessage {
    type: 'message';
    attachments: Array<{
        contentType: 'application/vnd.microsoft.card.adaptive';
        content: AdaptiveCard;
    }>;
}
