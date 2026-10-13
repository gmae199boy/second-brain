/**
 * The current time as a port, so Core is never tied to the system clock
 * (AD-1). Every stored instant is absolute: there is no relative time and no
 * natural-language date parsing anywhere in Core (AD-13).
 */
export interface Clock {
  /** The absolute instant right now, set once per event (AD-13). */
  now(): Date;
}
