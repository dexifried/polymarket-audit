const mem = require('../lib/memory');

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function run(){
  console.log('Touching heartbeat...');
  mem.touchHeartbeat();
  console.log('Last heartbeat:', mem.getLastHeartbeat());

  console.log('Saving open order #1');
  mem.saveOpenOrder({ orderId: 'o1', tokenId: 't1', side: 'buy', price: 0.45, size: 10 });
  console.log('Saving open order #2');
  mem.saveOpenOrder({ orderId: 'o2', tokenId: 't1', side: 'sell', price: 0.55, size: 5 });
  console.log('Open orders:', mem.getOpenOrders());

  console.log('Removing order o1');
  mem.removeOpenOrder('o1');
  console.log('Open orders after remove:', mem.getOpenOrders());

  console.log('Saving fills');
  mem.saveFill({ fillId: 'f1', orderId: 'o2', price:0.55, size:5 });
  mem.saveFill({ fillId: 'f2', orderId: 'o3', price:0.44, size:2 });
  console.log('Fills (limit 10):', mem.getFills(10));

  console.log('Saving position summary');
  mem.savePositionSummary({ positions: [{ tokenId:'t1', qty: 3 }], pnl: 1.23 });
  console.log('Current position summary:', mem.getPositionSummary());
}

run().catch(e=>{console.error(e); process.exit(1);});
