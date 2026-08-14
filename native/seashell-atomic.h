#ifndef SEASHELL_ATOMIC_H
#define SEASHELL_ATOMIC_H
#include <stdint.h>
typedef struct seashell_atomic_u64 seashell_atomic_u64;
seashell_atomic_u64 *seashell_atomic_u64_create(void);
void seashell_atomic_u64_destroy(seashell_atomic_u64 *counter);
void seashell_atomic_u64_add(seashell_atomic_u64 *counter, uint64_t value);
uint64_t seashell_atomic_u64_exchange_zero(seashell_atomic_u64 *counter);
#endif
