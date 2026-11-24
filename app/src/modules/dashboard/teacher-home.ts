/** Greeting key for the hour of the day (0–23). */
export const greetingFor = (hour: number) => (hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening');
