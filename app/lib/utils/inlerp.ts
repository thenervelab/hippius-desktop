/**
 * Inverse Linear Interpolation, get the fraction between `a` and `b` on which `v` resides.
 * Returns a value between 0 and 1 representing the relative position of `v` between `a` and `b`.
 * If `v` is not between `a` and `b`, the result can be outside the range [0, 1].
 */
export const inlerp = (a: number, b: number, v: number): number => {
    // Avoid division by zero
    if (a === b) {
        return 0;
    }
    return (v - a) / (b - a);
};
