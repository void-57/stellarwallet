class SearchedAddressDB {
  constructor() {
    this.dbName = "StellarWalletDB";
    this.version = 1;
    this.storeName = "searchedAddresses";
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, {
            keyPath: "id",
            autoIncrement: true
          });
          store.createIndex("timestamp", "timestamp", { unique: false });
          store.createIndex("xlmAddress", "xlmAddress", { unique: false });
        }
      };
    });
  }

  async saveSearchedAddress(
    xlmAddress,
    balance,
    timestamp = Date.now(),
    sourceInfo = null
  ) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const index = store.index("xlmAddress");
      
      // Check if address already exists
      const getRequest = index.getAll(xlmAddress);
      getRequest.onsuccess = () => {
        const existingRecords = getRequest.result;
        
        if (existingRecords.length > 0) {
          // Address exists, update the existing record
          const existingRecord = existingRecords[0];
          const updatedData = {
            ...existingRecord,
            balance,
            timestamp,
            formattedBalance: `${balance.toFixed(7)} XLM`,
          };
          
          const putRequest = store.put(updatedData);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          // Address doesn't exist, create new record
          const data = {
            xlmAddress,
            btcAddress: sourceInfo?.btcAddress || null,
            floAddress: sourceInfo?.floAddress || null,
            balance,
            timestamp,
            formattedBalance: `${balance.toFixed(7)} XLM`,
            isFromPrivateKey: !!(sourceInfo?.btcAddress || sourceInfo?.floAddress),
          };
          
          const addRequest = store.add(data);
          addRequest.onsuccess = () => resolve();
          addRequest.onerror = () => reject(addRequest.error);
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async getSearchedAddresses() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const index = store.index("timestamp");
      const request = index.getAll();
      request.onsuccess = () => {
        const results = request.result.sort(
          (a, b) => b.timestamp - a.timestamp
        );
        resolve(results.slice(0, 10));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteSearchedAddress(id) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clearAllSearchedAddresses() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}