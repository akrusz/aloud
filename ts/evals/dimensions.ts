/**
 * The rubric's dimension ids (rubric.md): one per numbered or lettered
 * dimension a single turn can exercise. 12 ("Holds the session") is
 * session-level and belongs to the soak judge, so it is not here.
 */

export const DIMENSION_IDS = [
    '1a',
    '1b',
    '1c',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '10',
    '11',
    '13',
    '14',
    '15',
    'F1',
    'F2',
    'F3',
    'F4',
    'P1',
    'P2',
    'P3',
    'E1',
    'E2',
    'E3',
    'O1',
    'O2',
] as const;

export type DimensionId = (typeof DIMENSION_IDS)[number];

export function isDimensionId(s: string): s is DimensionId {
    return (DIMENSION_IDS as readonly string[]).includes(s);
}

/** What kind of thing went wrong, not how badly, in the report's order.
 *  rubric.md ("Types") sorts the dimensions; FAMILIES in aggregate.ts the
 *  Phase 1 families. */
export const CHECK_TYPES = [
    { id: 'safety', label: 'Safety' },
    { id: 'conduct', label: 'Conduct' },
    { id: 'core', label: 'Core intent' },
    { id: 'ux', label: 'UX' },
] as const;

export type CheckType = (typeof CHECK_TYPES)[number]['id'];
