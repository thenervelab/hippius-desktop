import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

const UploadFileComponent = () => {
  const [status, setStatus] = useState<string>('');
  const [folderContents, setFolderContents] = useState<any[]>([]);
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

  const testListFolderContents = async () => {
    try {
      setStatus('Fetching folder contents...');
      const folderName = 'test-folder'; // You can make this dynamic if needed
      const folderMetadataCid = 'bafkreiclfqhwzmhtcjlbju4yn3h23pqckpd24mo3fn6erxhjrphe2epemm';
      
      const contents = await invoke('list_folder_contents', {
        folderName: folderName,
        folderMetadataCid: folderMetadataCid
      });
      
      setFolderContents(contents as any[]);
      setStatus(`Found ${(contents as any[]).length} items in folder`);
    } catch (error) {
      setStatus(`Error listing folder contents: ${error}`);
      console.error('Error listing folder:', error);
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h3>File Upload</h3>
        <button onClick={handleFileUpload} style={{ marginRight: '10px' }}>Select and Upload File</button>
      </div>
      
      <div style={{ marginTop: '20px' }}>
        <h3>Test Folder Listing</h3>
        <button onClick={testListFolderContents} style={{ marginBottom: '10px' }}>
          Test List Folder Contents
        </button>
        
        {folderContents.length > 0 && (
          <div style={{ marginTop: '10px' }}>
            <h4>Folder Contents:</h4>
            <ul>
              {folderContents.map((item, index) => (
                <li key={index}>
                  {item.file_name} (Size: {item.file_size} bytes)
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      
      <div style={{ marginTop: '20px' }}>
        <h4>Status:</h4>
        <p>{status}</p>
      </div>
    </div>
  );
};

export default UploadFileComponent;