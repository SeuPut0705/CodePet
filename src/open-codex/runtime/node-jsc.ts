import { getHeapStatistics } from "node:v8";

export function heapStats() {
  const heap = getHeapStatistics();
  return {
    heapSize: heap.used_heap_size,
    heapCapacity: heap.total_heap_size,
    objectCount: 0,
    extraMemorySize: process.memoryUsage().external,
  };
}
