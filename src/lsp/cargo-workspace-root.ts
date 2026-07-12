import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	awaitSharedAbortableOperation,
	createSharedAbortableOperation,
	type SharedAbortableOperation,
} from "./abortable-shared-operation.js";
import { type ManifestSnapshot, readAncestorManifestSnapshots, snapshotsAreFresh } from "./cargo-manifest-snapshot.js";
import { canonicalManifest, parseTrustedCargoMetadata, type TrustedCargoMetadata } from "./cargo-metadata-parser.js";
import { type CargoMetadataLoader, defaultCargoMetadataLoader } from "./cargo-metadata-process.js";

const CARGO_METADATA_FAILURE_BACKOFF_MS = 1_000;

export type { CargoMetadataLoader } from "./cargo-metadata-process.js";

export type Clock = () => number;

export interface CargoWorkspaceRootOptions {
	readonly cargoMetadataLoader?: CargoMetadataLoader;
	readonly now?: Clock;
	readonly signal?: AbortSignal;
}

interface CargoWorkspaceCacheEntry {
	readonly root: string;
	readonly snapshots: readonly ManifestSnapshot[];
}

interface CargoWorkspaceFailureCacheEntry {
	readonly expiresAtMs: number;
	readonly snapshots: readonly ManifestSnapshot[];
}

interface CargoWorkspaceRootRequest {
	readonly manifestDir: string;
	readonly loader: CargoMetadataLoader;
	readonly now: Clock;
	readonly signal: AbortSignal | undefined;
}

interface CargoWorkspaceGeneration {
	readonly snapshots: readonly ManifestSnapshot[];
}

interface CargoWorkspaceLoadRequest extends CargoWorkspaceRootRequest {
	readonly generation: CargoWorkspaceGeneration;
}

interface CargoWorkspaceInFlight {
	readonly generation: CargoWorkspaceGeneration;
	readonly operation: SharedAbortableOperation<string | undefined>;
}

interface PreparedCargoWorkspaceCache {
	readonly root: string;
	readonly entries: ReadonlyMap<string, CargoWorkspaceCacheEntry>;
}

const cargoWorkspaceRootCache = new Map<string, CargoWorkspaceCacheEntry>();
const cargoWorkspaceRootFailures = new Map<string, CargoWorkspaceFailureCacheEntry>();
const cargoWorkspaceRootInFlight = new Map<string, CargoWorkspaceInFlight>();

function realpathSafe(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function nearestCargoManifestDir(startDir: string): string | undefined {
	let dir = startDir;
	let prev = "";
	while (dir !== prev) {
		if (existsSync(join(dir, "Cargo.toml"))) return dir;
		prev = dir;
		dir = dirname(dir);
	}
	return undefined;
}

function cacheEntryFor(root: string, memberManifestDir: string): CargoWorkspaceCacheEntry | undefined {
	const snapshots = readAncestorManifestSnapshots(memberManifestDir);
	return snapshots === undefined ? undefined : { root, snapshots };
}

function prepareCargoWorkspaceCache(
	manifestDir: string,
	metadata: TrustedCargoMetadata,
): PreparedCargoWorkspaceCache | undefined {
	const entries = new Map<string, CargoWorkspaceCacheEntry>();
	for (const manifestPath of metadata.memberManifestPaths) {
		const manifestDir = dirname(manifestPath);
		const entry = cacheEntryFor(metadata.workspaceRoot, manifestDir);
		if (entry === undefined) return undefined;
		entries.set(manifestDir, entry);
	}

	const requestedManifestPath = canonicalManifest(join(manifestDir, "Cargo.toml"));
	if (requestedManifestPath === undefined) return undefined;
	const requestedEntry = cacheEntryFor(metadata.workspaceRoot, dirname(requestedManifestPath));
	if (requestedEntry === undefined) return undefined;
	entries.set(manifestDir, requestedEntry);
	return { root: metadata.workspaceRoot, entries };
}

function preparedCacheIsFresh(prepared: PreparedCargoWorkspaceCache): boolean {
	for (const entry of prepared.entries.values()) {
		if (!snapshotsAreFresh(entry.snapshots)) return false;
	}
	return true;
}

function commitCargoWorkspaceCache(prepared: PreparedCargoWorkspaceCache): void {
	for (const [manifestDir, entry] of prepared.entries) {
		cargoWorkspaceRootCache.set(manifestDir, entry);
	}
}

function cacheCargoWorkspaceFailure(manifestDir: string, nowMs: number, snapshots: readonly ManifestSnapshot[]): void {
	cargoWorkspaceRootFailures.set(manifestDir, {
		expiresAtMs: nowMs + CARGO_METADATA_FAILURE_BACKOFF_MS,
		snapshots,
	});
}

function cacheCargoWorkspaceLoadFailure(request: CargoWorkspaceLoadRequest): void {
	cacheCargoWorkspaceFailure(request.manifestDir, request.now(), request.generation.snapshots);
}

function cachedCargoWorkspaceFailure(manifestDir: string, nowMs: number): boolean {
	const cached = cargoWorkspaceRootFailures.get(manifestDir);
	if (cached === undefined) return false;
	if (nowMs >= cached.expiresAtMs) {
		cargoWorkspaceRootFailures.delete(manifestDir);
		return false;
	}
	if (snapshotsAreFresh(cached.snapshots)) return true;
	cargoWorkspaceRootFailures.delete(manifestDir);
	return false;
}

function isAbortError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	return error instanceof Error && error.name === "AbortError";
}

function sameCargoWorkspaceGeneration(left: CargoWorkspaceGeneration, right: CargoWorkspaceGeneration): boolean {
	if (left.snapshots.length !== right.snapshots.length) return false;
	return left.snapshots.every((snapshot, index) => {
		const candidate = right.snapshots[index];
		return (
			candidate !== undefined &&
			candidate.path === snapshot.path &&
			candidate.exists === snapshot.exists &&
			candidate.content === snapshot.content
		);
	});
}

function deleteInFlight(manifestDir: string, inFlight: SharedAbortableOperation<string | undefined>): void {
	if (cargoWorkspaceRootInFlight.get(manifestDir)?.operation === inFlight) {
		cargoWorkspaceRootInFlight.delete(manifestDir);
	}
}

function createInFlightCargoWorkspaceRoot(
	request: CargoWorkspaceLoadRequest,
): SharedAbortableOperation<string | undefined> {
	let inFlight: SharedAbortableOperation<string | undefined>;
	inFlight = createSharedAbortableOperation(
		(signal) => loadCargoWorkspaceRoot({ ...request, signal }),
		() => {
			deleteInFlight(request.manifestDir, inFlight);
		},
		() => {
			deleteInFlight(request.manifestDir, inFlight);
		},
	);
	return inFlight;
}

async function loadCargoWorkspaceRoot(request: CargoWorkspaceLoadRequest): Promise<string | undefined> {
	try {
		request.signal?.throwIfAborted();
		const manifestPath = join(request.manifestDir, "Cargo.toml");
		const output = await request.loader(manifestPath, request.signal);
		request.signal?.throwIfAborted();
		if (!snapshotsAreFresh(request.generation.snapshots)) {
			cacheCargoWorkspaceLoadFailure(request);
			return undefined;
		}

		const metadata = parseTrustedCargoMetadata(manifestPath, output);
		if (metadata === undefined || !snapshotsAreFresh(request.generation.snapshots)) {
			cacheCargoWorkspaceLoadFailure(request);
			return undefined;
		}

		const prepared = prepareCargoWorkspaceCache(request.manifestDir, metadata);
		if (
			prepared === undefined ||
			!snapshotsAreFresh(request.generation.snapshots) ||
			!preparedCacheIsFresh(prepared)
		) {
			cacheCargoWorkspaceLoadFailure(request);
			return undefined;
		}

		commitCargoWorkspaceCache(prepared);
		cargoWorkspaceRootFailures.delete(request.manifestDir);
		return prepared.root;
	} catch (error) {
		if (request.signal?.aborted || isAbortError(error)) throw error;
		cacheCargoWorkspaceLoadFailure(request);
		return undefined;
	}
}

function cachedCargoWorkspaceRoot(manifestDir: string): string | undefined {
	const cached = cargoWorkspaceRootCache.get(manifestDir);
	if (cached === undefined) return undefined;
	if (snapshotsAreFresh(cached.snapshots)) return cached.root;
	cargoWorkspaceRootCache.delete(manifestDir);
	return undefined;
}

async function cargoWorkspaceRoot(request: CargoWorkspaceRootRequest): Promise<string | undefined> {
	request.signal?.throwIfAborted();
	const cached = cachedCargoWorkspaceRoot(request.manifestDir);
	if (cached !== undefined) return cached;

	const nowMs = request.now();
	if (cachedCargoWorkspaceFailure(request.manifestDir, nowMs)) return undefined;

	const snapshots = readAncestorManifestSnapshots(request.manifestDir);
	if (snapshots === undefined) return undefined;
	const generation = { snapshots };
	const inFlight = cargoWorkspaceRootInFlight.get(request.manifestDir);
	if (inFlight !== undefined && sameCargoWorkspaceGeneration(inFlight.generation, generation)) {
		return awaitSharedAbortableOperation(inFlight.operation, request.signal);
	}

	const newInFlight = createInFlightCargoWorkspaceRoot({ ...request, generation });
	cargoWorkspaceRootInFlight.set(request.manifestDir, { generation, operation: newInFlight });
	return awaitSharedAbortableOperation(newInFlight, request.signal);
}

export async function resolveCargoWorkspaceRoot(
	startDir: string,
	options: CargoWorkspaceRootOptions = {},
): Promise<string | undefined> {
	const manifestDir = nearestCargoManifestDir(realpathSafe(startDir));
	if (manifestDir === undefined) return undefined;
	const canonicalManifestDir = realpathSafe(manifestDir);
	const root = await cargoWorkspaceRoot({
		manifestDir: canonicalManifestDir,
		loader: options.cargoMetadataLoader ?? defaultCargoMetadataLoader,
		now: options.now ?? Date.now,
		signal: options.signal,
	});
	return root ?? canonicalManifestDir;
}
