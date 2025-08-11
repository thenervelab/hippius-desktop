'use client';

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

interface TestResult {
  success: boolean;
  message: string;
  data?: any;
}

export default function PrivateFolderTest() {
  const [results, setResults] = useState<TestResult[]>([]);
  const [loading, setLoading] = useState(false);
  const { polkadotAddress, mnemonic } = useWalletAuth();

  // Hardcoded test values
  const TEST_VALUES = {
    accountId: polkadotAddress,
    folderMetadataCid: 'bafkreieptq462643z6judqz27h2a4i6dy7cdbf5vstxkaavfpyw6z2j4qa',
    folderName: 'testing-file-add122',
    fileName: 'stranger.jpeg',
    seedPhrase: mnemonic,
    subfolderPath: ['testing-file-add122','3-folder-inside-2'],
    fileData: new TextEncoder().encode('This is test file content for testing purposes'),
  };

  const addResult = (result: TestResult) => {
    setResults(prev => [...prev, { ...result, timestamp: new Date().toISOString() }]);
  };

  const clearResults = () => {
    setResults([]);
  };

  const testAddFileToPrivateFolder = async () => {
    setLoading(true);
    try {
      console.log('Testing add_file_to_private_folder...');
      
      const result = await invoke('add_file_to_private_folder', {
        accountId: TEST_VALUES.accountId,
        folderMetadataCid: TEST_VALUES.folderMetadataCid,
        folderName: TEST_VALUES.folderName,
        fileData: Array.from(TEST_VALUES.fileData), // Convert to number array
        fileName: TEST_VALUES.fileName,
        seedPhrase: TEST_VALUES.seedPhrase,
        subfolderPath: TEST_VALUES.subfolderPath,
      });

      addResult({
        success: true,
        message: 'add_file_to_private_folder completed successfully',
        data: result,
      });
    } catch (error) {
      addResult({
        success: false,
        message: `add_file_to_private_folder failed: ${error}`,
        data: error,
      });
    } finally {
      setLoading(false);
    }
  };

  const testRemoveFileFromPrivateFolder = async () => {
    setLoading(true);
    try {
      console.log('Testing remove_file_from_private_folder...');
      
      const result = await invoke('remove_file_from_private_folder', {
        accountId: TEST_VALUES.accountId,
        folderMetadataCid: TEST_VALUES.folderMetadataCid,
        folderName: TEST_VALUES.folderName,
        fileName: TEST_VALUES.fileName,
        seedPhrase: TEST_VALUES.seedPhrase,
        subfolderPath: TEST_VALUES.subfolderPath,
      });

      addResult({
        success: true,
        message: 'remove_file_from_private_folder completed successfully',
        data: result,
      });
    } catch (error) {
      addResult({
        success: false,
        message: `remove_file_from_private_folder failed: ${error}`,
        data: error,
      });
    } finally {
      setLoading(false);
    }
  };

  const testAddFileToRootFolder = async () => {
    setLoading(true);
    try {
      console.log('Testing add_file_to_private_folder (root folder)...');
      
      const result = await invoke('add_file_to_private_folder', {
        accountId: TEST_VALUES.accountId,
        folderMetadataCid: TEST_VALUES.folderMetadataCid,
        folderName: TEST_VALUES.folderName,
        fileData: Array.from(TEST_VALUES.fileData),
        fileName: 'root-test-file.txt',
        seedPhrase: TEST_VALUES.seedPhrase,
        subfolderPath: null, // Root folder
      });

      addResult({
        success: true,
        message: 'add_file_to_private_folder (root) completed successfully',
        data: result,
      });
    } catch (error) {
      addResult({
        success: false,
        message: `add_file_to_private_folder (root) failed: ${error}`,
        data: error,
      });
    } finally {
      setLoading(false);
    }
  };

  const testRemoveFileFromRootFolder = async () => {
    setLoading(true);
    try {
      console.log('Testing remove_file_from_private_folder (root folder)...');
      
      const result = await invoke('remove_file_from_private_folder', {
        accountId: TEST_VALUES.accountId,
        folderMetadataCid: TEST_VALUES.folderMetadataCid,
        folderName: TEST_VALUES.folderName,
        fileName: 'stranger.jpeg',
        seedPhrase: TEST_VALUES.seedPhrase,
        subfolderPath: null, // Root folder
      });

      addResult({
        success: true,
        message: 'remove_file_from_private_folder (root) completed successfully',
        data: result,
      });
    } catch (error) {
      addResult({
        success: false,
        message: `remove_file_from_private_folder (root) failed: ${error}`,
        data: error,
      });
    } finally {
      setLoading(false);
    }
  };

  const testListFolderContents = async () => {
    setLoading(true);
    try {
      console.log('Testing list_folder_contents...');
      
      const result = await invoke('list_folder_contents', {
        folderName: TEST_VALUES.folderName,
        folderMetadataCid: TEST_VALUES.folderMetadataCid,
        mainFolderName: null,
        subfolderPath: TEST_VALUES.subfolderPath,
      });

      addResult({
        success: true,
        message: 'list_folder_contents completed successfully',
        data: result,
      });
    } catch (error) {
      addResult({
        success: false,
        message: `list_folder_contents failed: ${error}`,
        data: error,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Private Folder Operations Test</h1>
      
      {/* Test Values Display */}
      <div className="bg-gray-100 p-4 rounded-lg mb-6">
        <h2 className="text-xl font-semibold mb-3">Test Values</h2>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div><strong>Account ID:</strong> {TEST_VALUES.accountId}</div>
          <div><strong>Folder Metadata CID:</strong> {TEST_VALUES.folderMetadataCid}</div>
          <div><strong>Folder Name:</strong> {TEST_VALUES.folderName}</div>
          <div><strong>File Name:</strong> {TEST_VALUES.fileName}</div>
          <div><strong>Subfolder Path:</strong> {TEST_VALUES.subfolderPath.join(' > ')}</div>
          <div><strong>File Data:</strong> {TEST_VALUES.fileData.length} bytes</div>
        </div>
      </div>

      {/* Test Buttons */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <button
          onClick={testAddFileToPrivateFolder}
          disabled={loading}
          className="bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white px-4 py-2 rounded"
        >
          {loading ? 'Testing...' : 'Add File (Subfolder)'}
        </button>

        <button
          onClick={testRemoveFileFromPrivateFolder}
          disabled={loading}
          className="bg-red-500 hover:bg-red-600 disabled:bg-gray-400 text-white px-4 py-2 rounded"
        >
          {loading ? 'Testing...' : 'Remove File (Subfolder)'}
        </button>

        <button
          onClick={testAddFileToRootFolder}
          disabled={loading}
          className="bg-green-500 hover:bg-green-600 disabled:bg-gray-400 text-white px-4 py-2 rounded"
        >
          {loading ? 'Testing...' : 'Add File (Root)'}
        </button>

        <button
          onClick={testRemoveFileFromRootFolder}
          disabled={loading}
          className="bg-orange-500 hover:bg-orange-600 disabled:bg-gray-400 text-white px-4 py-2 rounded"
        >
          {loading ? 'Testing...' : 'Remove File (Root)'}
        </button>

        <button
          onClick={testListFolderContents}
          disabled={loading}
          className="bg-purple-500 hover:bg-purple-600 disabled:bg-gray-400 text-white px-4 py-2 rounded"
        >
          {loading ? 'Testing...' : 'List Contents'}
        </button>

        <button
          onClick={clearResults}
          className="bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded"
        >
          Clear Results
        </button>
      </div>

      {/* Results */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Test Results</h2>
        {results.length === 0 ? (
          <p className="text-gray-500">No test results yet. Click a button above to run tests.</p>
        ) : (
          <div className="space-y-3">
            {results.map((result, index) => (
              <div
                key={index}
                className={`p-4 rounded-lg border ${
                  result.success 
                    ? 'bg-green-50 border-green-200' 
                    : 'bg-red-50 border-red-200'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className={`font-semibold ${
                      result.success ? 'text-green-800' : 'text-red-800'
                    }`}>
                      {result.success ? '✅ Success' : '❌ Error'}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                      {result.message}
                    </div>
                    {result.data && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-sm text-blue-600 hover:text-blue-800">
                          View Data
                        </summary>
                        <pre className="mt-2 text-xs bg-gray-100 p-2 rounded overflow-auto max-h-40">
                          {JSON.stringify(result.data, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 ml-2">
                    {new Date(result.timestamp || Date.now()).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}