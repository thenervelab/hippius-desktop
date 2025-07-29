export const decodeBytesToString = (bytes: number[]): string => {
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(new Uint8Array(bytes));
};
