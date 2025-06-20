export const shortIdFromHash = (input: string, length: number = 4): string => {
  const base = 36; // you can change to 62 for base62 if needed

  // Use the first few characters of the input to form a number
  const charsNeeded = Math.ceil(
    Math.log(Math.pow(base, length)) / Math.log(256)
  ); // bytes needed
  let n = 0;

  for (let i = 0; i < charsNeeded; i++) {
    n = (n << 8) + (input.charCodeAt(i) || 0);
  }

  // Force to unsigned 32-bit and encode
  const encoded = (n >>> 0).toString(base);

  // Pad or slice to desired length
  return encoded.slice(0, length).padStart(length, "0");
};
