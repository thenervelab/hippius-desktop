import { invoke } from '@tauri-apps/api/core';
import { useState, useRef } from 'react';
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

const UploadFileComponent = () => {
  const [status, setStatus] = useState<string>('');
  const { polkadotAddress, mnemonic } = useWalletAuth();
  const accountId = polkadotAddress;
  const seedPhrase = mnemonic;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readFileAsArrayBuffer = (file: File): Promise<number[]> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const arrayBuffer = reader.result as ArrayBuffer;
        const uint8Array = new Uint8Array(arrayBuffer);
        resolve(Array.from(uint8Array));
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  };

  const handleFileUpload = async () => {
    if (!fileInputRef.current || !fileInputRef.current.files) {
      setStatus('No file input available.');
      return;
    }

    const files = fileInputRef.current.files;
    if (files.length === 0) {
      setStatus('No file or folder selected.');
      return;
    }

    try {
      if (files.length === 1) {
        // Single file selected
        const file = files[0];
        setStatus(`Reading file: ${file.name}...`);
        const fileData = await readFileAsArrayBuffer(file);

        setStatus('Uploading...');
        const result = await invoke('encrypt_and_upload_file', {
          accountId: accountId,
          fileData: fileData,
          fileName: file.name,
          seedPhrase: seedPhrase,
          encryptionKey: null, // Adjust as needed
        });
        setStatus(`File uploaded successfully. CID: ${result}`);
      } else {
        // Multiple files selected (folder-like upload)
        setStatus('Reading files...');
        const filePromises = Array.from(files).map(async (file) => {
          const fileData = await readFileAsArrayBuffer(file);
          return [file.name, fileData] as [string, number[]];
        });
        const filesArray = await Promise.all(filePromises);

        setStatus('Uploading folder...');
        const result = await invoke('encrypt_and_upload_folder', {
          accountId: accountId,
          files: filesArray,
          folderName: 'uploaded_folder_' + Date.now(), // Generate a unique folder name
          seedPhrase: seedPhrase,
          encryptionKey: null, // Adjust as needed
        });
        setStatus(`Folder uploaded successfully. CID: ${result}`);
      }
    } catch (error) {
      setStatus(`Error: ${error}`);
    }
  };

  return (
    <div>
      <input
        type="file"
        ref={fileInputRef}
        multiple
        style={{ marginBottom: '10px' }}
        onChange={handleFileUpload}
      />
      <button onClick={handleFileUpload}>Upload Selected File or Folder</button>
      <p>{status}</p>
    </div>
  );
};

export default UploadFileComponent;