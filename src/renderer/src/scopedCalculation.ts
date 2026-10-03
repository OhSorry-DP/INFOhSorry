import { isFloorSeedCurrent, type AccountScope } from '../../shared/account';

export interface FloorState {
  scope: AccountScope;
  starFloor: number | null;
  rStarFloor: number | null;
}

export function transferFloor(floor: FloorState, previous: AccountScope, rowsOwner: AccountScope, next: AccountScope, clearRows: boolean): FloorState {
  const preserve = !clearRows && isFloorSeedCurrent(rowsOwner, previous)
    && isFloorSeedCurrent(floor.scope, rowsOwner) && next.iidxId === rowsOwner.iidxId;
  return { scope: next, starFloor: preserve ? floor.starFloor : null, rStarFloor: preserve ? floor.rStarFloor : null };
}

export interface ScopedCalculation<T> { scope: AccountScope; deps: readonly unknown[]; value: T }

export function calculateScoped<T>(previous: ScopedCalculation<T> | null, scope: AccountScope, deps: readonly unknown[], calculate: () => T): ScopedCalculation<T> {
  const reuse = scope.iidxId !== null && previous?.scope.iidxId === scope.iidxId
    && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]));
  return { scope: { ...scope }, deps, value: reuse ? previous!.value : calculate() };
}

export function reuseOsrInput<T extends { title: string; diff: string; lampNum: number }>(previous: { owner: string | null; input: T[] } | null, owner: string | null, input: T[]): T[] {
  return owner !== null && previous?.owner === owner && previous.input.length === input.length
    && input.every((item, i) => item.title === previous.input[i].title && item.diff === previous.input[i].diff && item.lampNum === previous.input[i].lampNum)
    ? previous.input : input;
}
