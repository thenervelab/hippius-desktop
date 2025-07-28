import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
const UploadFileComponent = () => {
  const [status, setStatus] = useState<string>('');
  const { polkadotAddress, mnemonic } = useWalletAuth();
  const accountId = polkadotAddress;
  const seedPhrase = mnemonic;

  const handleFileUpload = async () => {
    try {
      // Open file picker dialog
      const selected = await open({
        multiple: false, // Set to true if you want to allow multiple files
        filters: [{ name: 'All Files', extensions: ['*'] }], // Adjust filters as needed
      });

      if (typeof selected === 'string') {
        // Single file selected, pass the path to the Tauri command
        setStatus('Uploading...');
        const result = await invoke('encrypt_and_upload_file', {
          accountId: accountId,
          filePath: selected, // Pass the absolute file path
          seedPhrase: seedPhrase,
          encryptionKey: null, // Adjust as needed
        });
        setStatus(`File uploaded successfully. CID: ${result}`);
      } else if (Array.isArray(selected)) {
        // Handle multiple files if needed
        setStatus('Multiple files not supported in this example.');
      } else {
        setStatus('No file selected.');
      }
    } catch (error) {
      setStatus(`Error: ${error}`);
    }
  };

  return (
    <div>
      <button onClick={handleFileUpload}>Select and Upload File</button>
      <p>{status}</p>
    </div>
  );
};

export default UploadFileComponent;