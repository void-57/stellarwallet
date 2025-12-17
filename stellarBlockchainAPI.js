(function(GLOBAL) {
  'use strict';

  // Stellar Horizon API endpoints
  const HORIZON_URL = 'https://horizon.stellar.org'; // Mainnet
  
  const stellarAPI = {};
  let StellarSdk = null;
  let server = null;

  // Initialize Stellar SDK when available
  stellarAPI.init = function() {
    if (typeof window !== 'undefined') {
      const sdkCandidate = window.StellarSdk || window['stellar-sdk'] || window.StellarBase;
      
      if (sdkCandidate) {
        let ServerClass = null;
        if (sdkCandidate.Server) {
          ServerClass = sdkCandidate.Server;
          StellarSdk = sdkCandidate;
        } else if (sdkCandidate.Horizon && sdkCandidate.Horizon.Server) {
          ServerClass = sdkCandidate.Horizon.Server;
          StellarSdk = sdkCandidate; // Store the full SDK object
        }
        
        if (ServerClass) {
          try {
            server = new ServerClass(HORIZON_URL);
            return true;
          } catch (error) {
            console.error('❌ Error creating Server instance:', error);
            return false;
          }
        } else {
          console.error('❌ Server class not found in StellarSdk');
          return false;
        }
      } else {
        console.error('❌ StellarSdk not found on window');
        return false;
      }
    }
    console.warn('⚠️ Window object not available');
    return false;
  };
  
  stellarAPI.forceInit = function() {
    return stellarAPI.init();
  };

  // Get account balance and info
  stellarAPI.getBalance = async function(address) {
    try {
      const response = await fetch(`${HORIZON_URL}/accounts/${address}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Account not found. The account may not be funded yet.');
        }
        throw new Error(`Failed to fetch balance: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Find native XLM balance
      const nativeBalance = data.balances.find(b => b.asset_type === 'native');
      
      return {
        address: data.account_id,
        balance: nativeBalance ? parseFloat(nativeBalance.balance) : 0,
        balanceXlm: nativeBalance ? parseFloat(nativeBalance.balance) : 0,
        sequence: data.sequence,
        subentryCount: data.subentry_count,
        numSponsoring: data.num_sponsoring || 0,
        numSponsored: data.num_sponsored || 0,
        balances: data.balances, // All balances including assets
        signers: data.signers,
        flags: data.flags,
        thresholds: data.thresholds,
        lastModifiedLedger: data.last_modified_ledger,
        // Minimum balance calculation: (2 + subentry_count) * 0.5 XLM
        minBalance: (2 + data.subentry_count) * 0.5
      };
    } catch (error) {
      throw error;
    }
  };

  // Get transaction history with pagination
  stellarAPI.getTransactions = async function(address, options = {}) {
    const limit = options.limit || 10;
    const cursor = options.cursor || options.next || null;
    const order = options.order || 'desc'; // desc = newest first
    
    let url = `${HORIZON_URL}/accounts/${address}/transactions?limit=${limit}&order=${order}`;
    
    if (cursor) {
      url += `&cursor=${cursor}`;
    }
    
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch transactions: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Format transactions
      const transactions = await Promise.all((data._embedded.records || []).map(async tx => {
        // Get operations for this transaction to determine type and details
        const opsUrl = `${HORIZON_URL}/transactions/${tx.hash}/operations`;
        
        let operations = [];
        try {
          const opsResponse = await fetch(opsUrl);
          if (opsResponse.ok) {
            const opsData = await opsResponse.json();
            operations = opsData._embedded.records || [];
          }
        } catch (error) {
          console.warn('Failed to fetch operations for transaction:', tx.hash, error);
        }
        
        // Find payment operations
        const paymentOp = operations.find(op => 
          op.type === 'payment' || op.type === 'create_account'
        );
        
        let type = 'other';
        let amount = 0;
        let amountXlm = 0;
        let receiver = null;
        let sender = tx.source_account;
        
        if (paymentOp) {
          if (paymentOp.type === 'payment') {
            type = paymentOp.from === address ? 'sent' : 'received';
            amount = parseFloat(paymentOp.amount || 0);
            amountXlm = amount;
            receiver = paymentOp.to;
            sender = paymentOp.from;
          } else if (paymentOp.type === 'create_account') {
            type = paymentOp.funder === address ? 'sent' : 'received';
            amount = parseFloat(paymentOp.starting_balance || 0);
            amountXlm = amount;
            receiver = paymentOp.account;
            sender = paymentOp.funder;
          }
        }
        
        // Parse timestamp
        const timestamp = new Date(tx.created_at).getTime() / 1000;
        
        return {
          id: tx.id,
          hash: tx.hash,
          ledger: tx.ledger,
          createdAt: tx.created_at,
          sourceAccount: tx.source_account,
          fee: parseInt(tx.fee_charged || tx.max_fee),
          feeXlm: parseInt(tx.fee_charged || tx.max_fee) / 10000000,
          operationCount: tx.operation_count,
          successful: tx.successful,
          // Payment details
          type: type,
          sender: sender,
          receiver: receiver,
          amount: amount,
          amountXlm: amountXlm,
          memo: tx.memo || null,
          memoType: tx.memo_type || null,
          // Compatibility fields
          roundTime: timestamp,
          confirmedRound: tx.ledger
        };
      }));
      
      return {
        transactions,
        nextToken: data._embedded.records.length > 0 
          ? data._embedded.records[data._embedded.records.length - 1].paging_token 
          : null,
        hasMore: data._embedded.records.length === limit,
        cursor: data._embedded.records.length > 0 
          ? data._embedded.records[data._embedded.records.length - 1].paging_token 
          : null
      };
    } catch (error) {
      throw error;
    }
  };

  // Get transaction parameters (needed for sending)
  stellarAPI.getTransactionParams = async function(sourceAddress) {
    try {
      // Get latest ledger info for fee stats
      const response = await fetch(`${HORIZON_URL}/fee_stats`);
      const feeStats = await response.json();
      
      // Base fee in stroops (0.00001 XLM = 100 stroops)
      const baseFee = feeStats.last_ledger_base_fee || '100';
      
      return {
        fee: parseInt(baseFee),
        baseFee: baseFee,
        networkPassphrase: StellarSdk ? StellarSdk.Networks.PUBLIC : 'Public Global Stellar Network ; September 2015',
        genesisId: 'stellar-mainnet',
        genesisHash: 'stellar-mainnet'
      };
    } catch (error) {
      // Fallback to default fee
      return {
        fee: 100,
        baseFee: '100',
        networkPassphrase: StellarSdk ? StellarSdk.Networks.PUBLIC : 'Public Global Stellar Network ; September 2015',
        genesisId: 'stellar-mainnet',
        genesisHash: 'stellar-mainnet'
      };
    }
  };

  // Build and sign transaction using Stellar SDK
  stellarAPI.buildAndSignTransaction = async function(params) {
    const { sourceAddress, destinationAddress, amount, secretKey, memo } = params;
    
    if (!StellarSdk || !server) {
      throw new Error('Stellar SDK not initialized. Please refresh the page.');
    }
    
    try {
      // Load source account
      const sourceAccount = await server.loadAccount(sourceAddress);
      
      // Check if destination account exists
      let destinationExists = true;
      try {
        await server.loadAccount(destinationAddress);
      } catch (error) {
        if (error.response && error.response.status === 404) {
          destinationExists = false;
        } else {
          throw error;
        }
      }
      
      // Get fee stats
      const feeStats = await server.feeStats();
      
      // fee_charged.mode is typically 100 stroops (0.00001 XLM)
      const fee = feeStats.fee_charged?.mode || feeStats.last_ledger_base_fee || '100';
      
      // Build transaction
      let transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: fee,
        networkPassphrase: StellarSdk.Networks.PUBLIC
      });
      
      // Add operation based on whether destination exists
      if (destinationExists) {
        // Payment operation
        transaction = transaction.addOperation(
          StellarSdk.Operation.payment({
            destination: destinationAddress,
            asset: StellarSdk.Asset.native(),
            amount: amount.toString()
          })
        );
      } else {
        // Create account operation (requires minimum 1 XLM)
        if (parseFloat(amount) < 1) {
          throw new Error('Creating a new account requires a minimum of 1 XLM');
        }
        transaction = transaction.addOperation(
          StellarSdk.Operation.createAccount({
            destination: destinationAddress,
            startingBalance: amount.toString()
          })
        );
      }
      
      // Add memo if provided
      if (memo) {
        transaction = transaction.addMemo(StellarSdk.Memo.text(memo));
      }
      
      // Set timeout and build
      transaction = transaction.setTimeout(30).build();
      
      // Sign transaction
      const keypair = StellarSdk.Keypair.fromSecret(secretKey);
      transaction.sign(keypair);
      
      return {
        transaction: transaction,
        xdr: transaction.toEnvelope().toXDR('base64'),
        hash: transaction.hash().toString('hex'),
        destinationExists: destinationExists,
        fee: parseInt(fee)
      };
      
    } catch (error) {
      console.error('Error building transaction:', error);
      throw error;
    }
  };

  // Submit signed transaction
  stellarAPI.submitTransaction = async function(transactionXDR) {
    if (!StellarSdk || !server) {
      throw new Error('Stellar SDK not initialized. Please refresh the page.');
    }
    
    try {
      // Parse the XDR back to a transaction using TransactionBuilder
      const transaction = StellarSdk.TransactionBuilder.fromXDR(transactionXDR, StellarSdk.Networks.PUBLIC);
      
      console.log('Submitting transaction to Stellar network...');
      
      // Submit to network
      const result = await server.submitTransaction(transaction);
      
      console.log('✅ Transaction submitted successfully!');
      console.log('Transaction Details:', {
        hash: result.hash,
        ledger: result.ledger,
        successful: result.successful,
        envelope_xdr: result.envelope_xdr,
        result_xdr: result.result_xdr
      });
      
      return {
        hash: result.hash,
        ledger: result.ledger,
        successful: result.successful,
        txId: result.hash
      };
    } catch (error) {
      console.error('❌ Error submitting transaction:', error);
      
      // Parse Stellar error
      if (error.response && error.response.data) {
        const errorData = error.response.data;
        let errorMsg = errorData.title || 'Transaction failed';
        
        if (errorData.extras && errorData.extras.result_codes) {
          const codes = errorData.extras.result_codes;
          errorMsg += ': ' + (codes.transaction || codes.operations?.join(', ') || 'Unknown error');
        }
        
        throw new Error(errorMsg);
      }
      
      throw error;
    }
  };

  // Get single transaction by hash
  stellarAPI.getTransaction = async function(txHash) {
    try {
      const response = await fetch(`${HORIZON_URL}/transactions/${txHash}`);
      
      if (!response.ok) {
        throw new Error(`Transaction not found: ${response.status}`);
      }
      
      const tx = await response.json();
      
      // Get operations for this transaction
      const opsUrl = `${HORIZON_URL}/transactions/${tx.hash}/operations`;
      
      let operations = [];
      try {
        const opsResponse = await fetch(opsUrl);
        if (opsResponse.ok) {
          const opsData = await opsResponse.json();
          operations = opsData._embedded.records || [];
        }
      } catch (error) {
        console.warn('Failed to fetch operations for transaction:', tx.hash, error);
      }
      
      // Find payment operations
      const paymentOp = operations.find(op => 
        op.type === 'payment' || op.type === 'create_account'
      );
      
      let type = 'other';
      let amount = 0;
      let amountXlm = 0;
      let receiver = null;
      let sender = tx.source_account;
      
      if (paymentOp) {
        if (paymentOp.type === 'payment') {
          type = 'payment';
          amount = parseFloat(paymentOp.amount || 0);
          amountXlm = amount;
          receiver = paymentOp.to;
          sender = paymentOp.from;
        } else if (paymentOp.type === 'create_account') {
          type = 'create_account';
          amount = parseFloat(paymentOp.starting_balance || 0);
          amountXlm = amount;
          receiver = paymentOp.account;
          sender = paymentOp.funder;
        }
      }
      
      // Parse timestamp
      const timestamp = new Date(tx.created_at).getTime() / 1000;
      
      return {
        id: tx.id,
        hash: tx.hash,
        ledger: tx.ledger,
        createdAt: tx.created_at,
        sourceAccount: tx.source_account,
        fee: parseInt(tx.fee_charged || tx.max_fee),
        feeXlm: parseInt(tx.fee_charged || tx.max_fee) / 10000000,
        operationCount: tx.operation_count,
        successful: tx.successful,
        // Payment details
        type: type,
        sender: sender,
        receiver: receiver,
        amount: amount,
        amountXlm: amountXlm,
        memo: tx.memo || null,
        memoType: tx.memo_type || null,
        operations: operations,
        // Compatibility fields
        roundTime: timestamp,
        confirmedRound: tx.ledger
      };
    } catch (error) {
      throw error;
    }
  };

  // Format XLM amount for display
  stellarAPI.formatXLM = function(amount) {
    return parseFloat(amount).toFixed(7);
  };

  // Parse XLM to stroops (1 XLM = 10,000,000 stroops)
  stellarAPI.parseXLM = function(xlm) {
    return Math.floor(parseFloat(xlm) * 10000000);
  };

  // Validate Stellar address
  stellarAPI.isValidAddress = function(address) {
    // Stellar addresses start with 'G' and are 56 characters long
    if (!address || typeof address !== 'string') return false;
    if (address.length !== 56) return false;
    if (!address.startsWith('G')) return false;
    
    // Check if it's valid Base32
    const BASE32_REGEX = /^[A-Z2-7]+$/;
    return BASE32_REGEX.test(address);
  };

  // Validate Stellar secret key
  stellarAPI.isValidSecret = function(secret) {
    // Stellar secret keys start with 'S' and are 56 characters long
    if (!secret || typeof secret !== 'string') return false;
    if (secret.length !== 56) return false;
    if (!secret.startsWith('S')) return false;
    
    // Check if it's valid Base32
    const BASE32_REGEX = /^[A-Z2-7]+$/;
    return BASE32_REGEX.test(secret);
  };

  // Check initialization status
  stellarAPI.isInitialized = function() {
    return StellarSdk !== null && server !== null;
  };

  GLOBAL.stellarAPI = stellarAPI;
  GLOBAL.xlmAPI = stellarAPI; // Alias for compatibility

  // Auto-initialize when SDK is available with retry logic
  if (typeof window !== 'undefined') {
    let initAttempts = 0;
    const maxAttempts = 5;
    
    function tryInit() {
      initAttempts++;
      
      const success = stellarAPI.init();
      
      if (success) {
      } else if (initAttempts < maxAttempts) {
        const delay = initAttempts * 200;
        setTimeout(tryInit, delay);
      } else {
        console.error('❌ Failed to initialize Stellar SDK after', maxAttempts, 'attempts');
        
      }
    }
    
    window.addEventListener('load', function() {
      setTimeout(tryInit, 100);
    });
  }

})(typeof window !== 'undefined' ? window : global);