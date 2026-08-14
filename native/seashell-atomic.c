#include "seashell-atomic.h"
#include <stdatomic.h>
#include <stdlib.h>
struct seashell_atomic_u64 { _Atomic uint64_t value; };
seashell_atomic_u64 *seashell_atomic_u64_create(void) {
    seashell_atomic_u64 *counter = calloc(1, sizeof(seashell_atomic_u64));
    if (counter != NULL) atomic_init(&counter->value, 0);
    return counter;
}
void seashell_atomic_u64_destroy(seashell_atomic_u64 *counter) { free(counter); }
void seashell_atomic_u64_add(seashell_atomic_u64 *counter, uint64_t value) {
    if (counter != NULL) atomic_fetch_add_explicit(&counter->value, value, memory_order_relaxed);
}
uint64_t seashell_atomic_u64_exchange_zero(seashell_atomic_u64 *counter) {
    if (counter == NULL) return 0;
    return atomic_exchange_explicit(&counter->value, 0, memory_order_acq_rel);
}
