export interface Transaction {
  wallet: string;
  id: number;
  type: string;
  amount: number;
  date: string;
}

export const transactionsData: Transaction[] = [
  { wallet: "0x6887246668a3b87f54deb3b94ba4778abca0x3bef", id: 7426774, type: "TAO", amount: 4.13, date: "03/08/21  8:01pm" },
  { wallet: "0x6887246668a3b87f54deb3b94ba4778abca0x3bef", id: 5637657, type: "Credit Card", amount: 4.13, date: "03/07/21  12:27pm" },
  { wallet: "0x6887246668a3b87f54deb3b94ba4778abca0x3bef", id: 7527365, type: "TAO", amount: 4.13, date: "03/10/21  11:43am" },
  { wallet: "0x6887246668a3b87f54deb3b94ba4778abca0x3bef", id: 5262261, type: "Alpha", amount: 4.13, date: "03/03/21  10:48am" },
  { wallet: "0x6887246668a3b87f54deb3b94ba4778abca0x3bef", id: 9003235, type: "Alpha", amount: 4.13, date: "03/08/21  8:01pm" },
  { wallet: "0x6887246668a3b87f54deb3b94ba4778abca0x3bef", id: 5227365, type: "Credit Card", amount: 4.13, date: "02/26/21  9:40pm" },
  { wallet: "0x6887246668a3b87f54deb3b94ba4778abca0x3bef", id: 3545756, type: "Credit Card", amount: 4.13, date: "03/03/21  10:48am" },
  { wallet: "0x6887246668a3b87f54deb3b94ba4778abca0x3bef", id: 9002984, type: "Credit Card", amount: 4.13, date: "03/03/21  10:48am" },
  { wallet: "0x6887246668a3b87f54deb3b94ba4778abca0x3bef", id: 3342756, type: "Alpha", amount: 4.13, date: "03/03/21  10:48am" },
];