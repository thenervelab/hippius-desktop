import React, { useState, useEffect } from 'react';
import { invoke } from "@tauri-apps/api/core";

const WssEndpointTester = () => {
  const [currentEndpoint, setCurrentEndpoint] = useState('');
  const [newEndpoint, setNewEndpoint] = useState('');
  const [testEndpoint, setTestEndpoint] = useState('');
  const [loading, setLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState(''); // 'success' or 'error'

  // Load current endpoint on component mount
  useEffect(() => {
    loadCurrentEndpoint();
  }, []);

  const loadCurrentEndpoint = async () => {
    try {
      const endpoint: string = await invoke('get_wss_endpoint');
      setCurrentEndpoint(endpoint);
      setNewEndpoint(endpoint);
      setTestEndpoint(endpoint);
    } catch (error) {
      setMessage(`Error loading endpoint: ${error}`);
      setMessageType('error');
    }
  };

  const handleUpdate = async () => {
    if (!newEndpoint.trim()) {
      setMessage('Please enter a valid endpoint');
      setMessageType('error');
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      await invoke('update_wss_endpoint_command', { endpoint: newEndpoint });
      setCurrentEndpoint(newEndpoint);
      setMessage('WSS endpoint updated successfully!');
      setMessageType('success');
    } catch (error) {
      setMessage(`Error updating endpoint: ${error}`);
      setMessageType('error');
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    if (!testEndpoint.trim()) {
      setMessage('Please enter an endpoint to test');
      setMessageType('error');
      return;
    }

    setTestLoading(true);
    setMessage('');

    try {
      const result = await invoke('test_wss_endpoint_command', { endpoint: testEndpoint });
      if (result) {
        setMessage('Connection test successful!');
        setMessageType('success');
      } else {
        setMessage('Connection test failed');
        setMessageType('error');
      }
    } catch (error) {
      setMessage(`Connection test failed: ${error}`);
      setMessageType('error');
    } finally {
      setTestLoading(false);
    }
  };

  const handleReset = () => {
    setNewEndpoint(currentEndpoint);
    setTestEndpoint(currentEndpoint);
    setMessage('');
  };

  return (
    <div style={{ padding: '20px', maxWidth: '600px', margin: '0 auto' }}>
      <h2>WSS Endpoint Tester</h2>
      
      {/* Current Endpoint Display */}
      <div style={{ marginBottom: '20px', padding: '10px', backgroundColor: '#f5f5f5', borderRadius: '5px' }}>
        <strong>Current Endpoint:</strong>
        <div style={{ marginTop: '5px', fontFamily: 'monospace' }}>
          {currentEndpoint || 'Loading...'}
        </div>
      </div>

      {/* Update Endpoint Section */}
      <div style={{ marginBottom: '30px' }}>
        <h3>Update Endpoint</h3>
        <div style={{ marginBottom: '10px' }}>
          <input
            type="text"
            value={newEndpoint}
            onChange={(e) => setNewEndpoint(e.target.value)}
            placeholder="Enter new WSS endpoint"
            style={{
              width: '100%',
              padding: '8px',
              borderRadius: '4px',
              border: '1px solid #ccc'
            }}
          />
        </div>
        <button
          onClick={handleUpdate}
          disabled={loading}
          style={{
            padding: '10px 20px',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: loading ? 'not-allowed' : 'pointer',
            marginRight: '10px'
          }}
        >
          {loading ? 'Updating...' : 'Update Endpoint'}
        </button>
        <button
          onClick={handleReset}
          style={{
            padding: '10px 20px',
            backgroundColor: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Reset
        </button>
      </div>

      {/* Test Endpoint Section */}
      <div style={{ marginBottom: '30px' }}>
        <h3>Test Endpoint Connection</h3>
        <div style={{ marginBottom: '10px' }}>
          <input
            type="text"
            value={testEndpoint}
            onChange={(e) => setTestEndpoint(e.target.value)}
            placeholder="Enter endpoint to test"
            style={{
              width: '100%',
              padding: '8px',
              borderRadius: '4px',
              border: '1px solid #ccc'
            }}
          />
        </div>
        <button
          onClick={handleTest}
          disabled={testLoading}
          style={{
            padding: '10px 20px',
            backgroundColor: '#28a745',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: testLoading ? 'not-allowed' : 'pointer'
          }}
        >
          {testLoading ? 'Testing...' : 'Test Connection'}
        </button>
      </div>

      {/* Message Display */}
      {message && (
        <div
          style={{
            padding: '10px',
            borderRadius: '4px',
            backgroundColor: messageType === 'success' ? '#d4edda' : '#f8d7da',
            color: messageType === 'success' ? '#155724' : '#721c24',
            border: `1px solid ${messageType === 'success' ? '#c3e6cb' : '#f5c6cb'}`
          }}
        >
          {message}
        </div>
      )}

      {/* Quick Test Endpoints */}
      <div style={{ marginTop: '30px' }}>
        <h4>Quick Test Endpoints:</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {[
            'wss://rpc.hippius.network',
            'wss://rpc.polkadot.io',
            'wss://kusama-rpc.polkadot.io'
          ].map((endpoint) => (
            <button
              key={endpoint}
              onClick={() => setTestEndpoint(endpoint)}
              style={{
                padding: '5px 10px',
                backgroundColor: '#f8f9fa',
                border: '1px solid #dee2e6',
                borderRadius: '3px',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'monospace'
              }}
            >
              {endpoint}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default WssEndpointTester;