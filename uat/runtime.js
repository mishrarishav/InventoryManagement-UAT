/* GitHub Pages UAT adapter. Loaded only into exported pages, never into production MVC. */
(() => {
  'use strict';
  const base = window.INVENTORY_UAT_BASE;
  const nativeFetch = window.fetch.bind(window);
  const storageName = `inventory-uat:${base}:v1`;
  const sessionKey = `${storageName}:session`;
  const isLogin = /\/Users\/Login\/?$/i.test(location.pathname);
  let store;
  let SQL;

  async function retryLoad(action) {
    for (let attempt = 0; ; attempt++) {
      try { return await action(); }
      catch (error) {
        if (attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
  }

  function openStore() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(storageName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function readDatabase() {
    return new Promise((resolve, reject) => {
      const request = store.transaction('files').objectStore('files').get('inventory.db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function persist(bytes) {
    return new Promise((resolve, reject) => {
      const transaction = store.transaction('files', 'readwrite');
      transaction.objectStore('files').put(bytes, 'inventory.db');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Could not save UAT data'));
    });
  }

  let queue = Promise.resolve();
  function locked(action) {
    if (navigator.locks) return navigator.locks.request(storageName, action);
    const current = queue.then(action, action);
    queue = current.catch(() => {});
    return current;
  }

  const ready = (async () => {
    [SQL, store] = await Promise.all([
      retryLoad(() => window.initSqlJs({ locateFile: file => `${base}uat/vendor/${file}` })), openStore()
    ]);
    await locked(async () => {
      if (!(await readDatabase())) {
        const bytes = await retryLoad(async () => {
          const seed = await nativeFetch(`${base}uat/seed.db`);
          if (!seed.ok) throw new Error('Could not load sample UAT data');
          return new Uint8Array(await seed.arrayBuffer());
        });
        await persist(bytes);
      }
    });
  })();

  async function database(write, action) {
    await ready;
    return locked(async () => {
      const bytes = await readDatabase();
      if (!bytes) throw new Error('UAT database is missing');
      const db = new SQL.Database(bytes);
      try {
        db.run('PRAGMA foreign_keys=ON');
        if (write) db.run('BEGIN');
        const result = await action(db);
        if (write) {
          db.run('COMMIT');
          await persist(db.export());
        }
        return result;
      } finally { db.close(); }
    });
  }

  const camel = value => value === 'ID' ? 'id' : (value[0].toLowerCase() + value.slice(1)).replace(/ID$/, 'Id');
  function rows(db, sql, parameters = []) {
    const statement = db.prepare(sql);
    try {
      statement.bind(parameters);
      const result = [];
      while (statement.step()) {
        const row = statement.getAsObject();
        result.push(Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value])));
      }
      return result;
    } finally { statement.free(); }
  }
  const one = (db, sql, parameters = []) => rows(db, sql, parameters)[0];
  const number = value => value === '' || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  const currentUser = () => { try { return JSON.parse(sessionStorage.getItem(sessionKey)); } catch { return null; } };
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  const int = value => Number.isSafeInteger(number(value)) ? number(value) : fail('Enter a valid whole number.');
  const now = () => new Date().toISOString();
  async function hash(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  const controllers = {
    rackmaster: ['RackMaster', 'RackID', ['RackNumber', 'Description']],
    levelmaster: ['LevelMaster', 'LevelID', ['RackID', 'LevelNumber', 'Description']],
    binmaster: ['BinMaster', 'BinID', ['LevelID', 'BinNumber', 'Capacity', 'Description']],
    locationmaster: ['LocationMaster', 'LocationID', ['LocationName', 'Address', 'Description', 'LocationType']],
    materialtype: ['MaterialType', 'ID', ['Name']],
    material: ['MaterialMaster', 'MaterialID', ['MaterialName', 'MaterialTypeID', 'Specifications', 'UnitOfMeasure', 'ReOrderLevel', 'Price', 'BarCode', 'DangerLevel']],
    materialmapping: ['MaterialMapping', 'Id', ['MaterialId', 'LocationId', 'RackId', 'BinId', 'LevelId']],
    users: ['Users', 'UserID', ['Username', 'Role', 'Name', 'MobileNo', 'EmailId']]
  };

  function materialRows(db) {
    return rows(db, `SELECT m.*, t.Name AS MaterialType FROM MaterialMaster m LEFT JOIN MaterialType t ON m.MaterialTypeID=t.ID`);
  }
  function mappingRows(db, stock = false, materialId = null) {
    const table = stock ? 'InventoryItems' : 'MaterialMapping';
    return rows(db, `SELECT x.*, ${stock ? 'x.ItemID' : 'x.Id'} AS MappingId,
      m.MaterialName, r.RackNumber, l.LevelNumber, b.BinNumber
      FROM ${table} x JOIN MaterialMaster m ON m.MaterialID=x.MaterialID
      JOIN RackMaster r ON r.RackID=x.RackID JOIN LevelMaster l ON l.LevelID=x.LevelID
      JOIN BinMaster b ON b.BinID=x.BinID WHERE (? IS NULL OR x.MaterialID=?)`, [materialId, materialId]);
  }

  function report(db, kind, query, limit = null) {
    const material = number(query.get('materialid'));
    const start = query.get('startdate') || null;
    const end = query.get('enddate') || null;
    if (kind === 'lowstock') return rows(db, `SELECT a.*, m.MaterialName FROM LowStockAlert a
      JOIN MaterialMaster m ON m.MaterialID=a.MaterialID WHERE (? IS NULL OR a.MaterialID=?)
      AND (? IS NULL OR substr(a.AlertDate,1,10)>=?) AND (? IS NULL OR substr(a.AlertDate,1,10)<=?)`,
      [material, material, start, start, end, end]);
    const inward = kind === 'inward';
    const inventory = kind === 'inventory';
    const table = inventory ? 'InventoryItems' : inward ? 'MaterialInward' : 'MaterialOutward';
    const date = inventory ? 'LastUpdated' : inward ? 'InwardDate' : 'OutwardDate';
    const location = number(query.get(inward ? 'supplierid' : 'customerid'));
    let sql = `SELECT x.${date}, m.MaterialName, m.BarCode, x.Quantity, m.UnitOfMeasure,
      r.RackNumber, l.LevelNumber, b.BinNumber ${inventory ? '' : inward ? ',s.LocationName AS SupplierLocation' : ',s.LocationName,s.LocationName AS IssuedTo,x.MachineId'}
      FROM ${table} x JOIN MaterialMaster m ON m.MaterialID=x.MaterialID
      JOIN RackMaster r ON r.RackID=x.RackID JOIN LevelMaster l ON l.LevelID=x.LevelID
      JOIN BinMaster b ON b.BinID=x.BinID
      ${inventory ? '' : `JOIN LocationMaster s ON s.LocationID=x.${inward ? 'SupplierId' : 'CustomerId'}`}
      WHERE (? IS NULL OR x.MaterialID=?) AND (? IS NULL OR substr(x.${date},1,10)>=?)
      AND (? IS NULL OR substr(x.${date},1,10)<=?)`;
    const parameters = [material, material, start, start, end, end];
    if (!inventory) { sql += ` AND (? IS NULL OR s.LocationID=?)`; parameters.push(location, location); }
    sql += ` ORDER BY x.${date} DESC`;
    if (limit) { sql += ' LIMIT ?'; parameters.push(limit); }
    return rows(db, sql, parameters);
  }

  function moveStock(db, data, inward) {
    const quantity = int(data.quantity);
    if (quantity <= 0) fail('Quantity must be greater than zero.');
    const material = int(data.materialid), binId = int(data.binid), rackId = int(data.rackid), levelId = int(data.levelid);
    const bin = one(db, `SELECT b.*, l.RackID FROM BinMaster b JOIN LevelMaster l ON l.LevelID=b.LevelID WHERE b.BinID=?`, [binId]);
    if (!bin || bin.levelId !== levelId || bin.rackId !== rackId) fail('Choose a valid rack, shelf and bin.');
    if (!one(db, 'SELECT * FROM MaterialMaster WHERE MaterialID=?', [material])) fail('Choose a valid material.');
    const location = int(data[inward ? 'supplierid' : 'customerid']);
    if (!one(db, 'SELECT * FROM LocationMaster WHERE LocationID=?', [location])) fail('Choose a valid supplier or customer.');
    const stock = one(db, 'SELECT * FROM InventoryItems WHERE MaterialID=? AND BinID=? AND RackID=? AND LevelID=?', [material, binId, rackId, levelId]);
    const timestamp = now();
    if (inward) {
      const used = one(db, 'SELECT COALESCE(SUM(Quantity),0) AS Used FROM InventoryItems WHERE BinID=?', [binId]).used;
      if (bin.capacity != null && quantity > bin.capacity - used) fail(`Insufficient bin space. Available space: ${bin.capacity - used}`);
      if (stock) db.run('UPDATE InventoryItems SET Quantity=Quantity+?,LastUpdated=?,Status=? WHERE ItemID=?', [quantity, timestamp, 'Available', stock.itemId]);
      else db.run('INSERT INTO InventoryItems (MaterialID,Quantity,RackID,LevelID,BinID,Status,LastUpdated) VALUES (?,?,?,?,?,?,?)', [material, quantity, rackId, levelId, binId, 'Available', timestamp]);
      db.run('INSERT INTO MaterialInward (MaterialID,Quantity,RackID,LevelID,BinID,InwardDate,UserID,SupplierId) VALUES (?,?,?,?,?,?,?,?)', [material, quantity, rackId, levelId, binId, timestamp, currentUser().userId, location]);
    } else {
      if (!stock || stock.quantity < quantity) fail(`Insufficient stock. Available quantity: ${stock?.quantity || 0}`);
      db.run('UPDATE InventoryItems SET Quantity=Quantity-?,LastUpdated=?,Status=? WHERE ItemID=?', [quantity, timestamp, quantity === stock.quantity ? 'Empty' : 'Available', stock.itemId]);
      db.run('INSERT INTO MaterialOutward (MaterialID,Quantity,RackID,LevelID,BinID,OutwardDate,UserID,CustomerId,MachineId) VALUES (?,?,?,?,?,?,?,?,?)', [material, quantity, rackId, levelId, binId, timestamp, currentUser().userId, location, data.machineid || null]);
    }
    const total = one(db, 'SELECT SUM(Quantity) AS Total FROM InventoryItems WHERE MaterialID=?', [material]).total;
    const reorder = one(db, 'SELECT ReOrderLevel FROM MaterialMaster WHERE MaterialID=?', [material]).reOrderLevel;
    const alert = one(db, "SELECT * FROM LowStockAlert WHERE MaterialID=? AND Status='Low Stock'", [material]);
    if (reorder != null && total < reorder) {
      if (alert) db.run('UPDATE LowStockAlert SET Quantity=?,ReOrderLevel=? WHERE AlertID=?', [total, reorder, alert.alertId]);
      else db.run('INSERT INTO LowStockAlert (MaterialID,AlertDate,Quantity,ReOrderLevel,Status) VALUES (?,?,?,?,?)', [material, timestamp, total, reorder, 'Low Stock']);
    } else db.run("UPDATE LowStockAlert SET Status='Resolved' WHERE MaterialID=? AND Status='Low Stock'", [material]);
    return null;
  }

  async function dispatch(db, url, method, data) {
    const path = url.pathname.toLowerCase().replace(base.toLowerCase().replace(/\/$/, ''), '').replace(/\/$/, '');
    const [controller, action] = path.split('/').filter(Boolean);
    const query = new URLSearchParams(Array.from(url.searchParams, ([key, value]) => [key.toLowerCase(), value]));
    if (path === '/users/login' && method === 'POST') {
      const user = one(db, 'SELECT * FROM Users WHERE Username=?', [data.username]);
      if (!user || user.passwordHash !== await hash(data.password || '')) fail('Invalid username or password.');
      delete user.passwordHash;
      return user;
    }
    if (!currentUser()) throw Object.assign(new Error('Please log in to UAT.'), { status: 401 });
    if (method === 'POST') {
      if (path === '/materialmovement/createinward') return moveStock(db, data, true);
      if (path === '/materialmovement/createoutward') return moveStock(db, data, false);
      if (path === '/users/changepassword') {
        if (!data.password || data.password.length < 8) fail('Use a password of at least 8 characters.');
        db.run('UPDATE Users SET PasswordHash=? WHERE UserID=?', [await hash(data.password), int(data.userid)]);
        return null;
      }
      const descriptor = controllers[controller];
      if (!descriptor || !['create', 'edit'].includes(action)) fail('This action is unavailable in Pages UAT.');
      const [table, primaryKey, columns] = descriptor;
      const id = number(data[primaryKey.toLowerCase()]);
      const update = action === 'edit' || (controller === 'materialmapping' && id > 0);
      const parameters = columns.map(column => {
        const value = data[column.toLowerCase()];
        if (/(?:id|level|price|capacity|type)$/i.test(column) && !['MachineId', 'EmailId'].includes(column)) return number(value);
        return value == null || value === '' ? null : String(value);
      });
      const required = { rackmaster: ['racknumber'], levelmaster: ['levelnumber', 'rackid'], binmaster: ['binnumber', 'levelid'], locationmaster: ['locationname'], materialtype: ['name'], material: ['materialname', 'unitofmeasure'], users: ['username', 'role', 'name'], materialmapping: ['materialid', 'rackid', 'levelid', 'binid'] }[controller];
      if (required.some(key => data[key] == null || String(data[key]).trim() === '')) fail('Fill in the required fields.');
      if (update) {
        if (!id || !one(db, `SELECT ${primaryKey} FROM ${table} WHERE ${primaryKey}=?`, [id])) fail('Record no longer exists.');
        db.run(`UPDATE ${table} SET ${columns.map(column => `${column}=?`).join(',')} WHERE ${primaryKey}=?`, [...parameters, id]);
      } else {
        const insertColumns = [...columns];
        if (controller === 'users') {
          if (!data.passwordhash || data.passwordhash.length < 8) fail('Use a password of at least 8 characters.');
          insertColumns.push('PasswordHash', 'CreatedAt');
          parameters.push(await hash(data.passwordhash), now());
        }
        db.run(`INSERT INTO ${table} (${insertColumns.join(',')}) VALUES (${insertColumns.map(() => '?').join(',')})`, parameters);
      }
      return null;
    }

    if (path === '/uat/dashboard') return one(db, `SELECT
      (SELECT COALESCE(SUM(i.Quantity*m.Price),0) FROM InventoryItems i JOIN MaterialMaster m ON m.MaterialID=i.MaterialID) AS InventoryValue,
      (SELECT COALESCE(SUM(Quantity),0) FROM InventoryItems) AS InventoryCount,
      (SELECT COUNT(*) FROM InventoryItems i JOIN MaterialMaster m ON m.MaterialID=i.MaterialID WHERE i.Quantity<m.ReOrderLevel) AS LowStockCount,
      (SELECT COALESCE(SUM(Quantity),0)*100.0 / NULLIF((SELECT SUM(Capacity) FROM BinMaster),0) FROM InventoryItems) AS CapacityUtilization`);
    if (controller === 'report' || controller === 'materialmovement') {
      if (action.includes('inwardreport')) return report(db, 'inward', query, action.includes('dashboard') || controller === 'materialmovement' ? 20 : null);
      if (action.includes('outwardreport')) return report(db, 'outward', query, action.includes('dashboard') || controller === 'materialmovement' ? 20 : null);
      if (action === 'materialinventoryreport') return report(db, 'inventory', query);
      if (action === 'lowstockreport') return report(db, 'lowstock', query);
      if (action === 'getlocationbymaterial') return mappingRows(db, true, number(query.get('materialid')));
      if (action === 'getexistingquantity') return { existingQuantity: one(db, 'SELECT COALESCE(SUM(Quantity),0) AS Quantity FROM InventoryItems WHERE MaterialID=?', [number(query.get('materialid'))]).quantity };
    }
    if (controller === 'material') {
      if (action === 'getall') return materialRows(db);
      if (action === 'getmaterialbybarcode') {
        const material = one(db, 'SELECT * FROM MaterialMaster WHERE BarCode=?', [query.get('barcode')]);
        return material ? { status: '1', data: material } : { status: '0' };
      }
    }
    if (controller === 'materialmapping') return mappingRows(db, false, action === 'getlocationbymaterial' ? number(query.get('materialid')) : null);
    if (controller === 'rackmaster') return rows(db, 'SELECT *, RackNumber AS RackName FROM RackMaster');
    if (controller === 'levelmaster') return rows(db, `SELECT l.*,r.RackNumber AS RackName FROM LevelMaster l JOIN RackMaster r ON r.RackID=l.RackID WHERE (? IS NULL OR l.RackID=?)`, [number(query.get('rackid')), number(query.get('rackid'))]);
    if (controller === 'binmaster') return rows(db, `SELECT b.*, l.LevelNumber AS LevelName, l.RackID, r.RackNumber AS RackName
      FROM BinMaster b JOIN LevelMaster l ON l.LevelID=b.LevelID JOIN RackMaster r ON r.RackID=l.RackID
      WHERE (? IS NULL OR b.LevelID=?)`, [number(query.get('levelid')), number(query.get('levelid'))]);
    if (controller === 'materialtype') return rows(db, 'SELECT * FROM MaterialType');
    if (controller === 'users') return rows(db, 'SELECT UserID,Username,Role,Name,MobileNo,EmailId,CreatedAt,LastLogin FROM Users');
    if (controller === 'locationmaster') {
      const type = { getlocations: 1, getissueto: 2, getsuppliers: 3, getmachine: 4 }[action];
      return rows(db, `SELECT *,LocationType AS TypeId,CASE LocationType WHEN 1 THEN 'Location' WHEN 2 THEN 'Customer' WHEN 3 THEN 'Supplier' ELSE 'Machine' END AS LocationTypeName
        FROM LocationMaster WHERE (? IS NULL OR LocationType=?)`, [type ?? null, type ?? null]);
    }
    fail('This request is unavailable in Pages UAT.');
  }

  function apiUrl(input) {
    const url = new URL(input, location.href);
    if (url.origin !== location.origin) return null;
    const route = url.pathname.startsWith(base) ? url.pathname.slice(base.length - 1) : url.pathname;
    return /^\/(Users|RackMaster|LevelMaster|BinMaster|LocationMaster|MaterialType|Material|MaterialMapping|MaterialMovement|Report|Uat)\/(Get\w*|Create\w*|Edit|ChangePassword|Material\w*Report\w*|LowStockReport|InwardReport|OutwardReport|Dashboard|Login)$/i.test(route) ? url : null;
  }

  async function request(input, options = {}) {
    const url = new URL(input, location.href);
    const method = (options.method || 'GET').toUpperCase();
    let data = options.body || {};
    if (typeof data === 'string') data = JSON.parse(data || '{}');
    data = Object.fromEntries(Object.entries(data).map(([key, value]) => [key.toLowerCase(), value]));
    return database(method !== 'GET', db => dispatch(db, url, method, data));
  }

  function installJQuery($) {
    $.ajaxTransport('+*', options => {
      if (!apiUrl(options.url)) return undefined;
      let cancelled = false;
      return {
        send(_, complete) {
          request(options.url, { method: options.type, body: options.data }).then(
            data => { if (!cancelled) complete(200, 'success', { text: JSON.stringify(data) }, 'Content-Type: application/json'); },
            error => { if (!cancelled) complete(error.status || 500, 'error', { text: error.message }); }
          );
        },
        abort() { cancelled = true; }
      };
    });
  }

  window.fetch = async (input, options) => {
    if (typeof input !== 'string' || !apiUrl(input)) return nativeFetch(input, options);
    try { return new Response(JSON.stringify(await request(input, options)), { headers: { 'Content-Type': 'application/json' } }); }
    catch (error) { return new Response(error.message, { status: error.status || 500 }); }
  };
  window.InventoryUat = { request, installJQuery, ready };

  function message(text, error = false) {
    let notice = document.getElementById('uat-status');
    if (!notice) {
      notice = document.createElement('div'); notice.id = 'uat-status';
      notice.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:11000;padding:9px 16px;background:#eef2ff;color:#373071;font:13px system-ui;display:flex;gap:16px;align-items:center;flex-wrap:wrap;border-top:1px solid #d4d3e8';
      document.body.append(notice);
    }
    notice.replaceChildren(document.createTextNode(text));
    if (error) notice.style.background = '#fee2e2';
    return notice;
  }

  async function hydrate() {
    await ready;
    const notice = message(isLogin ? 'Pages UAT · Demo login: uatadmin / Uat@12345678 · Data stays in this browser.' : 'Pages UAT · Data saved in this browser · Use sample data only.');
    if (isLogin) return;
    const backup = document.createElement('button');
    backup.textContent = 'Download backup';
    backup.onclick = async () => {
      try {
        const bytes = await database(false, db => db.export());
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/x-sqlite3' }));
        link.download = `inventory-uat-${new Date().toISOString().slice(0, 10)}.db`;
        link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      } catch (error) { message(`Backup failed: ${error.message}`, true); }
    };
    notice.append(backup);

    // Populate server-rendered selects from the current browser DB, including records added after export.
    await database(false, db => {
      const materials = materialRows(db);
      const fill = (id, list, value, label) => {
        const select = document.getElementById(id);
        if (!select || select.tagName !== 'SELECT') return;
        const first = select.options[0]?.text || 'Select';
        select.replaceChildren(new Option(first, ''), ...list.map(row => new Option(row[label] ?? '', row[value])));
      };
      if (!/\/MaterialMovement\//i.test(location.pathname)) {
        fill('materialDescription', materials, 'materialId', 'materialName');
        fill('materialBarcode', materials, 'materialId', 'barCode');
        if (/\/Report\//i.test(location.pathname)) fill('materialId', materials, 'materialId', 'materialName');
      }
      fill('supplierId', rows(db, 'SELECT * FROM LocationMaster WHERE LocationType=3'), 'locationId', 'locationName');
      fill('customerId', rows(db, 'SELECT * FROM LocationMaster WHERE LocationType=2'), 'locationId', 'locationName');
      if (/\/MaterialMapping\//i.test(location.pathname)) fill('rack', rows(db, 'SELECT * FROM RackMaster'), 'rackId', 'rackNumber');
    });
    if (/\/Report\/Dashboard/i.test(location.pathname)) {
      const data = await request('/Uat/Dashboard');
      document.getElementById('genValue').textContent = data.inventoryValue;
      document.getElementById('InValue').textContent = data.inventoryCount;
      const values = document.querySelectorAll('#PenValue');
      values[0].textContent = data.lowStockCount;
      values[1].textContent = `${Number(data.capacityUtilization || 0).toFixed(1)} %`;
    }
  }

  if (!isLogin && !currentUser()) location.replace(`${base}Users/Login/`);
  document.addEventListener('DOMContentLoaded', () => {
    message('Pages UAT · Opening your local test data…');
    hydrate().catch(error => message(`Could not open UAT data: ${error.message}. Refresh to retry.`, true));
    if (isLogin) {
      const submit = document.querySelector('form.login button[type="submit"]');
      submit.disabled = true;
      ready.then(() => { submit.disabled = false; }).catch(() => {});
      document.querySelector('form.login').addEventListener('submit', async event => {
        event.preventDefault();
        try {
          const user = await request('/Users/Login', { method: 'POST', body: {
            username: document.getElementById('username').value, password: document.getElementById('password').value
          } });
          sessionStorage.setItem(sessionKey, JSON.stringify(user));
          location.assign(`${base}Report/Dashboard/`);
        } catch (error) { message(error.message, true); }
      });
    }
    document.querySelectorAll('a[href="#uat-logout"]').forEach(link => link.addEventListener('click', event => {
      event.preventDefault(); sessionStorage.removeItem(sessionKey); location.assign(`${base}Users/Login/`);
    }));
  });
})();
