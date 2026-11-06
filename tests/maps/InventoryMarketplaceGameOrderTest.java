package org.agentcity.paper;

import java.util.*;

/** Public response validation only; does not provision wallets or send transactions. */
public final class InventoryMarketplaceGameOrderTest {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static void refuses(Map<String,Object> order,Map<String,Object> quote,String key,Object value){
        Map<String,Object> changed=new HashMap<>(order);if(value==null)changed.remove(key);else changed.put(key,value);
        try{InventoryMarketplace.gameOrder(changed,quote);throw new AssertionError("Accepted changed "+key);}catch(IllegalArgumentException expected){}
    }
    public static void main(String[] args){
        Map<String,Object> quote=Map.of("quoteId","12345678-1234-1234-1234-123456789012","item","oak_planks","count",4,"unitPriceCity","0.125","totalCity","0.5","expiresAtMs",System.currentTimeMillis()+60000);
        Map<String,Object> order=new HashMap<>(quote);order.putAll(Map.of("mode","privy_game","orderId","abcdef12-1234-1234-1234-123456789012","consentNonce","A".repeat(43),"chainId",1301,"status","wallet_required","totalBaseUnits","500000000000000000","paid",false));
        check(InventoryMarketplace.gameOrder(order,quote).get("status").equals("wallet_required"),"Wallet enrollment must not require an existing wallet");
        order.putAll(Map.of("status","ready","walletAddress","0x1111111111111111111111111111111111111111","maxNativeFeeWei","9000000000000","maxNativeFeeEth","0.000009"));
        check(InventoryMarketplace.gameOrder(order,quote).get("unitPriceCity").equals("0.125"),"Keep canonical reviewed unit price");
        check(InventoryMarketplace.gameFee(order).equals("0.000009"),"Show exact total fee cap");
        refuses(order,quote,"mode","browser");refuses(order,quote,"chainId",1);refuses(order,quote,"orderId","another-order");refuses(order,quote,"quoteId","other-quote");refuses(order,quote,"consentNonce","short");
        refuses(order,quote,"item","diamond");refuses(order,quote,"count",5);refuses(order,quote,"totalCity","0.6");refuses(order,quote,"totalBaseUnits","500000000000000001");
        refuses(order,quote,"walletAddress",null);refuses(order,quote,"walletAddress","not-a-wallet");refuses(order,quote,"maxNativeFeeEth","0.00001");refuses(order,quote,"paid","true");
        Map<String,Object> noFee=new HashMap<>(order);noFee.remove("maxNativeFeeWei");refuses(noFee,quote,"maxNativeFeeEth",null);
        for(String state:List.of("expired","reverted","funding_pending","ready_to_collect")){Map<String,Object> view=new HashMap<>(order);view.put("status",state);check(InventoryMarketplace.gameOrder(view,quote).get("status").equals(state),"Keep canonical recovery status: "+state);}
        check(!InventoryMarketplace.gameDeliveryConfirmed(order),"A ready order has not delivered");
        order.put("status","delivered");check(!InventoryMarketplace.gameDeliveryConfirmed(order),"A status label cannot claim delivery");
        order.put("paid",true);check(!InventoryMarketplace.gameDeliveryConfirmed(order),"A payment alone cannot claim delivery");
        order.put("deliveryConfirmed",true);check(InventoryMarketplace.gameDeliveryConfirmed(order),"Require canonical native delivery confirmation");
        System.out.println("{\"status\":\"pass\",\"checks\":25,\"scope\":\"Native Privy order binding, exact totals, wallet, fee cap and delivery claim guards; no wallet or payment calls\"}");
    }
}
