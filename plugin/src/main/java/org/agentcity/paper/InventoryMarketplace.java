package org.agentcity.paper;

import java.math.BigDecimal;
import java.net.URI;
import java.util.*;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Predicate;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import org.bukkit.*;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.inventory.*;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.*;
import org.bukkit.inventory.*;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;

/** Native browsing and review only. The owner's browser wallet signs payments. */
public final class InventoryMarketplace implements Listener {
    private static final int[] GOODS={19,21,23,25,28,30,32,34};
    private final JavaPlugin plugin;
    private final Predicate<Player> approved;
    private final Function<Player,String> connectionId;
    @FunctionalInterface public interface Queue { String submit(Player player,String action,Map<String,Object> fields); }
    private final Queue queue;
    private record Pending(UUID playerId,String connection,String action,Map<String,Object> fields,Menu previous,Consumer<Map<String,Object>> show,boolean collect) {}
    private final Map<String,Pending> pending=new HashMap<>();
    private final NamespacedKey buttonKey;
    private final Set<UUID> loading=new HashSet<>();
    private final Set<String> consentAttempts=new HashSet<>();
    private final Set<String> fundingAttempts=new HashSet<>();
    private boolean closed;
    public InventoryMarketplace(JavaPlugin plugin,Predicate<Player> approved,Function<Player,String> connectionId,Queue queue){
        this.plugin=Objects.requireNonNull(plugin);this.approved=Objects.requireNonNull(approved);
        this.connectionId=Objects.requireNonNull(connectionId);this.queue=Objects.requireNonNull(queue);buttonKey=new NamespacedKey(plugin,"inventory_marketplace");
    }
    public void start(){Bukkit.getPluginManager().registerEvents(this,plugin);}
    public void close(){closed=true;loading.clear();pending.clear();consentAttempts.clear();fundingAttempts.clear();HandlerList.unregisterAll(this);}
    public boolean isButton(ItemStack item){return item!=null&&item.hasItemMeta()&&item.getItemMeta().getPersistentDataContainer().has(buttonKey,PersistentDataType.BYTE);}
    public static boolean owns(Inventory inventory){return inventory!=null&&inventory.getHolder() instanceof Menu;}
    public void giveButton(Player player){
        if(closed||!approved.test(player))return;
        for(ItemStack item:player.getInventory().getContents())if(isButton(item))return;
        if(player.getInventory().firstEmpty()<0){player.sendMessage("Inventory full. Use /market to open the UniRock marketplace.");return;}
        ItemStack item=icon(Material.COMPASS,"UniRock Marketplace","Right-click to shop for building materials.","Choose an item, quantity, then review CITY cost.");
        ItemMeta meta=item.getItemMeta();meta.getPersistentDataContainer().set(buttonKey,PersistentDataType.BYTE,(byte)1);item.setItemMeta(meta);player.getInventory().addItem(item);
    }
    private boolean allowed(Player player){
        if(closed)return false;
        if(!approved.test(player)){player.sendMessage("Approve this connection in Discord before opening the marketplace.");return false;}return true;
    }
    public void open(Player player){if(allowed(player))request(player,"catalog",Map.of(),value->catalog(player,value));}
    private static final class Menu implements InventoryHolder {
        final UUID owner;final String connection,page;final Map<String,Object> value;final int count,step;
        Inventory inventory;Map<String,Object> choice=Map.of();Runnable back,primary,fund,resume;String requestId;
        Menu(Player player,String connection,String page,Map<String,Object> value,int count,int step){owner=player.getUniqueId();this.connection=connection;this.page=page;this.value=value;this.count=count;this.step=step;}
        @Override public Inventory getInventory(){return inventory;}
    }
    private ItemStack icon(Material material,String title,String... lore){
        ItemStack item=new ItemStack(material);ItemMeta meta=item.getItemMeta();meta.setDisplayName(ChatColor.WHITE+title);
        meta.setLore(Arrays.stream(lore).map(line->ChatColor.GRAY+line).toList());item.setItemMeta(meta);return item;
    }
    private static int integer(Object value){if(!(value instanceof Number n)||n.longValue()!=n.doubleValue()||n.longValue()<0||n.longValue()>100000)throw new IllegalArgumentException("inventory_shop_count_required");return n.intValue();}
    private static String text(Map<String,Object> value,String key){if(!(value.get(key) instanceof String s)||s.length()>2000)throw new IllegalArgumentException("inventory_shop_text_required");return s;}
    private static Material material(String name){Material result=Material.matchMaterial(name);return result==null?Material.BARRIER:result;}
    private static String title(String name){StringJoiner result=new StringJoiner(" ");for(String word:name.replace("minecraft:","").split("_"))if(!word.isEmpty())result.add(Character.toUpperCase(word.charAt(0))+word.substring(1));return result.toString();}
    private static BigDecimal price(String value){if(!value.matches("(?:0|[1-9][0-9]{0,17})(?:\\.[0-9]{1,18})?"))throw new IllegalArgumentException("inventory_shop_price_required");BigDecimal price=new BigDecimal(value);if(price.signum()<=0)throw new IllegalArgumentException("inventory_shop_price_required");return price;}
    private static String total(Map<String,Object> entry,int count){return price(text(entry,"unitPriceCity")).multiply(BigDecimal.valueOf(count)).stripTrailingZeros().toPlainString();}
    private static boolean expiring(Map<String,Object> quote){Object raw=quote.get("expiresAtMs");if(!(raw instanceof Number n)||n.longValue()!=n.doubleValue()||n.longValue()<0)throw new IllegalArgumentException("inventory_shop_expiry_required");return n.longValue()<=System.currentTimeMillis()+5000;}
    private Menu menu(Player player,String page,Map<String,Object> value,int count,String title,int step){
        Menu menu=new Menu(player,connectionId.apply(player),page,value,count,step);menu.inventory=Bukkit.createInventory(menu,54,"UniRock | "+title);
        for(int slot=0;slot<54;slot++)menu.inventory.setItem(slot,icon(slot<9||slot>=45?Material.BLACK_STAINED_GLASS_PANE:Material.GRAY_STAINED_GLASS_PANE," "));
        menu.inventory.setItem(4,icon(Material.NETHER_STAR,ChatColor.GOLD+"UniRock Marketplace","Building materials · CITY test tokens","Choose item > Quantity > Review > Checkout"));
        String[] steps={"Choose Item","Quantity","Review","Checkout"};
        for(int i=0;i<4;i++)menu.inventory.setItem(10+i*2,icon(i==step?Material.CYAN_STAINED_GLASS_PANE:i<step?Material.LIME_STAINED_GLASS_PANE:Material.GRAY_DYE,
            (i==step?ChatColor.AQUA:i<step?ChatColor.GREEN:ChatColor.GRAY)+String.valueOf(i+1)+". "+steps[i],i==step?"You are here.":i<step?"Completed.":"Next step."));
        menu.inventory.setItem(45,icon(Material.ARROW,page.equals("catalog")?"Back to Game":"Back"));
        menu.inventory.setItem(47,icon(Material.BOOK,"Help","A simple guide to CITY test-token purchases."));
        menu.inventory.setItem(53,icon(Material.BARRIER,ChatColor.RED+"Close","Return to the game."));
        menu.back=()->open(player);return menu;
    }
    private void primary(Menu menu,String label,String... lore){menu.inventory.setItem(49,icon(Material.LIME_CONCRETE,ChatColor.GREEN+"➜ "+label,lore));}
    private ItemStack selected(Map<String,Object> entry,int count){
        ItemStack item=icon(material(text(entry,"item")),ChatColor.AQUA+title(text(entry,"item")),"Selected: "+count+" item"+(count==1?"":"s"),"Each: "+text(entry,"unitPriceCity")+" CITY","Total: "+total(entry,count)+" CITY");
        item.setAmount(Math.min(64,Math.max(1,count)));return item;
    }
    @SuppressWarnings("unchecked") private void catalog(Player player,Map<String,Object> value){
        if(!(value.get("entries") instanceof List<?> entries)||entries.size()>GOODS.length)throw new IllegalArgumentException("inventory_shop_catalog_required");
        Menu menu=menu(player,"catalog",value,1,"1 / 4  Choose Item",0);menu.back=player::closeInventory;
        for(int i=0;i<entries.size();i++){
            Map<String,Object> entry=(Map<String,Object>)entries.get(i);String item=text(entry,"item");int available=integer(entry.get("available"));price(text(entry,"unitPriceCity"));
            menu.inventory.setItem(GOODS[i],icon(available>0?material(item):Material.GRAY_DYE,(available>0?ChatColor.WHITE:ChatColor.DARK_GRAY)+title(item),
                "Each: "+text(entry,"unitPriceCity")+" CITY",available>0?"In stock: "+available:"Out of stock",available>0?ChatColor.AQUA+"Click to choose quantity.":"Choose another material or check again later."));
        }
        menu.inventory.setItem(40,icon(Material.PAPER,"Choose a Material Above","The number of items and total cost come next.","Nothing is purchased by browsing."));
        if(value.get("activeOrder") instanceof Map<?,?> raw) {
            @SuppressWarnings("unchecked") Map<String,Object> snapshot=gameOrder((Map<String,Object>)raw,(Map<String,Object>)raw);
            Map<String,Object> currentChoice=Map.of("item",text(snapshot,"item"),"unitPriceCity",text(snapshot,"unitPriceCity"),"available",0);
            for(Object entry:entries)if(entry instanceof Map<?,?> item&&Objects.equals(item.get("item"),snapshot.get("item"))){@SuppressWarnings("unchecked") Map<String,Object> found=(Map<String,Object>)item;currentChoice=found;break;}
            Map<String,Object> choice=currentChoice;
            if("ready_to_collect".equals(snapshot.get("status"))&&Boolean.TRUE.equals(snapshot.get("paid"))){gameCheckout(player,snapshot,snapshot,choice);return;}
            menu.inventory.setItem(40,icon(Material.CLOCK,"Resume My Purchase","Check the original purchase and its delivery.","Order: "+text(snapshot,"orderId"),"This does not authorize a new payment."));
            menu.resume=()->request(player,"status",Map.of("orderId",text(snapshot,"orderId")),reply->gameCheckout(player,reply,snapshot,choice));
        }
        menu.inventory.setItem(49,icon(Material.COMPASS,"Refresh Stock","Reload the available materials."));menu.primary=()->open(player);player.openInventory(menu.inventory);
    }
    private void quantity(Player player,Map<String,Object> entry,int requested){
        int stock=integer(entry.get("available")),available=Math.min(64,stock);if(available<1){outOfStock(player,entry,requested);return;}
        int count=Math.max(1,Math.min(available,requested));Menu menu=menu(player,"quantity",entry,count,"2 / 4  Choose Quantity",1);menu.choice=entry;
        menu.inventory.setItem(22,selected(entry,count));
        menu.inventory.setItem(28,icon(Material.REDSTONE_BLOCK,"−8 Items","Choose "+Math.max(1,count-8)+" items."));
        menu.inventory.setItem(29,icon(Material.RED_DYE,"−1 Item","Choose "+Math.max(1,count-1)+" items."));
        menu.inventory.setItem(33,icon(Material.LIME_DYE,"+1 Item","Choose "+Math.min(available,count+1)+" items."));
        menu.inventory.setItem(34,icon(Material.EMERALD,"+8 Items","Choose "+Math.min(available,count+8)+" items."));
        menu.inventory.setItem(31,icon(Material.PAPER,ChatColor.GOLD+"Total: "+total(entry,count)+" CITY","Quantity: "+count+" items","In stock: "+stock,"Your wallet confirmation comes later."));
        int[] quantities={1,8,16,available};int[] slots={37,39,41,43};
        for(int i=0;i<quantities.length;i++)menu.inventory.setItem(slots[i],icon(quantities[i]<=available?Material.LIGHT_BLUE_DYE:Material.GRAY_DYE,
            (i==3?"Max: ":"Set to ")+quantities[i]+" Item"+(quantities[i]==1?"":"s"),quantities[i]<=available?"Use this exact quantity.":"Not enough stock for this quantity."));
        primary(menu,"Review "+count+" Items","Total: "+total(entry,count)+" CITY","Check the exact order before opening checkout.");
        menu.primary=()->request(player,"quote",Map.of("item",text(entry,"item"),"count",count),value->review(player,value,entry,false));player.openInventory(menu.inventory);
    }
    private void review(Player player,Map<String,Object> quote,Map<String,Object> choice,boolean refreshed){
        int count=integer(quote.get("count"));if(count<1||count>64||price(text(quote,"totalCity")).compareTo(price(text(quote,"unitPriceCity")).multiply(BigDecimal.valueOf(count)))!=0)throw new IllegalArgumentException("inventory_shop_total_required");
        expiring(quote);Menu menu=menu(player,"review",quote,count,"3 / 4  Review Order",2);menu.choice=choice;menu.back=()->quantity(player,choice,count);
        menu.inventory.setItem(22,selected(quote,count));
        menu.inventory.setItem(31,icon(Material.PAPER,ChatColor.GOLD+"Total: "+text(quote,"totalCity")+" CITY","You receive: "+count+" "+title(text(quote,"item")),"Test network: Unichain Sepolia","The next page shows the maximum test ETH fee."));
        menu.inventory.setItem(40,icon(Material.BOOK,refreshed?"Review Refreshed — Check the Total":"Review Before Paying","Continuing does not spend CITY.","Use your Privy game wallet inside Minecraft.","Payment needs a separate Pay button click."));
        if(Boolean.TRUE.equals(quote.get("paymentReady"))){
            primary(menu,"Continue to Payment","Next: check your game wallet and exact payment.","CITY test tokens only. No payment yet.");menu.primary=()->{
                if(expiring(quote))request(player,"quote",Map.of("item",text(quote,"item"),"count",count),value->review(player,value,choice,true));
                else request(player,"checkout",Map.of("quoteId",text(quote,"quoteId")),value->checkout(player,value,quote,choice));
            };
        }else menu.inventory.setItem(49,icon(Material.GRAY_CONCRETE,"Checkout Is Not Ready","You can browse and choose materials.","Please check again when the shop is ready."));
        player.openInventory(menu.inventory);
    }
    private void checkout(Player player,Map<String,Object> value,Map<String,Object> quote,Map<String,Object> choice){
        if("privy_game".equals(value.get("mode"))){gameCheckout(player,value,quote,choice);return;}
        URI url=URI.create(text(value,"checkoutUrl"));
        if(!"http".equals(url.getScheme())||!"127.0.0.1".equals(url.getHost())||url.getPort()!=8789||url.getUserInfo()!=null||!"/inventory-shop/checkout".equals(url.getPath()))throw new IllegalArgumentException("inventory_shop_local_checkout_required");
        Menu menu=menu(player,"checkout",quote,integer(quote.get("count")),"4 / 4  Secure Checkout",3);menu.choice=choice;menu.back=()->review(player,quote,choice,false);
        menu.inventory.setItem(22,selected(quote,menu.count));menu.inventory.setItem(31,icon(Material.BOOK,"Your Secure Checkout Is Ready","The link opens this Mac's checkout page.","Connect your own wallet and review the order.","Only you can approve its CITY transaction."));
        primary(menu,"Open Secure Checkout","Close this menu and show your clickable link.","Your wallet asks for confirmation in the browser.");
        menu.primary=()->{player.closeInventory();player.sendMessage(Component.text("Open secure UniRock checkout — review and confirm in your wallet.").clickEvent(ClickEvent.openUrl(url.toString())));};player.openInventory(menu.inventory);
    }
    static Map<String,Object> gameOrder(Map<String,Object> value,Map<String,Object> quote) {
        if(!"privy_game".equals(value.get("mode"))||integer(value.get("chainId"))!=1301
            ||!text(value,"orderId").matches("[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")
            ||!text(value,"consentNonce").matches("[A-Za-z0-9_-]{43}")
            ||!text(value,"quoteId").equals(text(quote,"quoteId"))||!text(value,"item").equals(text(quote,"item"))
            ||integer(value.get("count"))!=integer(quote.get("count"))
            ||price(text(value,"totalCity")).compareTo(price(text(quote,"totalCity")))!=0
            ||!price(text(value,"totalCity")).movePointRight(18).toBigIntegerExact().toString().equals(text(value,"totalBaseUnits"))
            ||!Set.of("wallet_required","ready","insufficient_funds","pending","funding_pending","ready_to_collect","delivered","expired","reverted","cancelled").contains(text(value,"status"))
            ||!(value.get("paid") instanceof Boolean))throw new IllegalArgumentException("inventory_shop_game_order_required");
        Object wallet=value.get("walletAddress");
        if(wallet!=null&&(!(wallet instanceof String address)||!address.matches("0x[a-fA-F0-9]{40}")))throw new IllegalArgumentException("inventory_shop_game_wallet_required");
        if("ready".equals(value.get("status"))&&(wallet==null||gameFee(value)==null))throw new IllegalArgumentException("inventory_shop_game_payment_terms_required");
        Map<String,Object> summary=new HashMap<>(quote);summary.putAll(value);summary.put("unitPriceCity",text(quote,"unitPriceCity"));
        return Map.copyOf(summary);
    }
    static String gameFee(Map<String,Object> value) {
        String fee=null;
        if(value.containsKey("maxNativeFeeWei")) {
            String wei=text(value,"maxNativeFeeWei");if(!wei.matches("[0-9]{1,78}"))throw new IllegalArgumentException("inventory_shop_game_fee_required");
            fee=new BigDecimal(wei).movePointLeft(18).stripTrailingZeros().toPlainString();
        }
        if(value.containsKey("maxNativeFeeEth")) {
            String eth=text(value,"maxNativeFeeEth");if(!eth.matches("(?:0|[1-9][0-9]{0,59})(?:\\.[0-9]{1,18})?"))throw new IllegalArgumentException("inventory_shop_game_fee_required");
            if(fee!=null&&new BigDecimal(fee).compareTo(new BigDecimal(eth))!=0)throw new IllegalArgumentException("inventory_shop_game_fee_required");fee=eth;
        }
        return fee;
    }
    static boolean gameDeliveryConfirmed(Map<String,Object> value) {
        return "delivered".equals(value.get("status"))&&Boolean.TRUE.equals(value.get("paid"))&&Boolean.TRUE.equals(value.get("deliveryConfirmed"));
    }
    private void gameStatus(Player player,Map<String,Object> order,Map<String,Object> choice) {
        request(player,"status",Map.of("orderId",text(order,"orderId")),value->gameCheckout(player,value,order,choice));
    }
    private void gameCheckout(Player player,Map<String,Object> value,Map<String,Object> quote,Map<String,Object> choice) {
        Map<String,Object> order=gameOrder(value,quote);String state=text(order,"status"),id=text(order,"orderId"),consentKey=id+":"+text(order,"consentNonce");int count=integer(order.get("count"));
        boolean delivered=gameDeliveryConfirmed(order),ready="ready".equals(state)&&Boolean.FALSE.equals(order.get("paid"))&&Boolean.FALSE.equals(order.get("paymentConsentRecorded"))&&!consentAttempts.contains(consentKey),collect="ready_to_collect".equals(state)&&Boolean.TRUE.equals(order.get("paid"));
        String heading="wallet_required".equals(state)?"Create Game Wallet":ready?"Confirm Purchase":"insufficient_funds".equals(state)?"Add CITY to Game Wallet":delivered?"Purchase Complete":collect?"Collect Materials":"expired".equals(state)?"Review Expired":"reverted".equals(state)?"Payment Reverted":"funding_pending".equals(state)?"Funding Pending":"Check Purchase";
        Menu menu=menu(player,"game_checkout",order,count,"4 / 4  "+heading,3);menu.choice=choice;
        menu.back=consentAttempts.contains(consentKey)||Boolean.TRUE.equals(order.get("paymentConsentRecorded"))?player::closeInventory:()->review(player,quote,choice,false);
        menu.inventory.setItem(22,selected(order,count));
        menu.inventory.setItem(31,icon(Material.PAPER,ChatColor.GOLD+"Total: "+text(order,"totalCity")+" CITY","You receive: "+count+" "+title(text(order,"item")),"Network: Unichain Sepolia (1301)","Order: "+id));
        if(order.get("walletAddress") instanceof String wallet)menu.inventory.setItem(40,icon(Material.ENDER_CHEST,"Your Privy Game Wallet",wallet,"AgentCity-managed testnet wallet.","This does not use your MetaMask wallet.","Maximum fee: "+Objects.toString(gameFee(order),"not available")+" test ETH"));
        if("wallet_required".equals(state)) {
            menu.inventory.setItem(40,icon(Material.BOOK,"A Separate Game Wallet","Create an AgentCity-managed Privy testnet wallet.","This is not your existing MetaMask wallet.","Creating a wallet spends no CITY.","You will review a separate payment afterward."));
            primary(menu,"Create my Privy game wallet","Create the disclosed game wallet only.","No CITY payment is authorized by this click.");
            menu.primary=()->request(player,"enroll",Map.of("orderId",id),reply->gameCheckout(player,reply,order,choice));
        } else if(ready) {
            primary(menu,"Pay "+text(order,"totalCity")+" CITY","Buy exactly "+count+" "+title(text(order,"item"))+".","Use the displayed Privy game wallet.","Maximum fee: "+gameFee(order)+" test ETH");
            menu.primary=()->{
                if(expiring(quote)){request(player,"quote",Map.of("item",text(order,"item"),"count",count),reply->review(player,reply,choice,true));return;}
                if(!consentAttempts.add(consentKey)){gameStatus(player,order,choice);return;}
                request(player,"confirm",Map.of("orderId",id,"consentNonce",text(order,"consentNonce")),reply->gameCheckout(player,reply,order,choice));
            };
        } else if("expired".equals(state)&&Boolean.FALSE.equals(order.get("paid"))&&Boolean.FALSE.equals(order.get("paymentConsentRecorded"))) {
            menu.inventory.setItem(39,icon(Material.CLOCK,"Review Expired","Check a fresh price and quantity before paying.","This does not send or repeat a payment."));
            primary(menu,"Refresh Review","Keep this material and quantity selected.","Review the new total before a separate Pay click.");
            menu.primary=()->request(player,"quote",Map.of("item",text(order,"item"),"count",count),reply->review(player,reply,choice,true));
        } else if(collect) {
            menu.inventory.setItem(39,icon(Material.CHEST,"Your Paid Materials Are Ready","Close this shop to receive the existing order.","Keep your cursor empty and inventory space free.","No new payment is requested."));
            primary(menu,"Collect materials","Close the menu and collect this paid order.","No repeated payment confirmation.");
            menu.primary=()->request(player,"status",Map.of("orderId",id),reply->gameCheckout(player,reply,order,choice),true);menu.back=player::closeInventory;
        } else if(delivered) {
            menu.inventory.setItem(40,icon(Material.EMERALD_BLOCK,"Purchase Delivered","Payment and native inventory delivery are confirmed.","Received: "+count+" "+title(text(order,"item")),"Total paid: "+text(order,"totalCity")+" CITY"));
            primary(menu,"Return to Game","Your confirmed order is complete.");menu.primary=player::closeInventory;menu.back=player::closeInventory;
        } else {
            String balance=order.get("cityBalance") instanceof String b?b:order.get("balanceCity") instanceof String b?b:"not available";
            String nativeBalance=order.get("nativeBalanceWei") instanceof String wei&&wei.matches("[0-9]{1,78}")?new BigDecimal(wei).movePointLeft(18).stripTrailingZeros().toPlainString():"not available";
            menu.inventory.setItem(39,icon("insufficient_funds".equals(state)?Material.PAPER:Material.CLOCK,"insufficient_funds".equals(state)?"Wallet Balance (information)":"Purchase Status: "+state,"CITY balance: "+balance,"Test ETH balance: "+nativeBalance,"Required: "+text(order,"totalCity")+" CITY","This is information, not a button.","Items appear only after confirmed delivery."));
            primary(menu,"Check purchase","Check this same order and its delivery.","This click does not authorize a new payment.");menu.primary=()->gameStatus(player,order,choice);
            if("insufficient_funds".equals(state)&&Boolean.TRUE.equals(order.get("fundingAvailable"))&&Boolean.FALSE.equals(order.get("paymentConsentRecorded"))&&!consentAttempts.contains(consentKey)&&!fundingAttempts.contains(id)) {
                menu.inventory.setItem(43,icon(Material.GOLD_BLOCK,"Get 1 test CITY + 0.0001 test ETH","One disclosed starter grant for this game wallet.","This is separate from the older demo grants.","No purchase or payment is authorized."));
                menu.fund=()->{if(!fundingAttempts.add(id)){gameStatus(player,order,choice);return;}request(player,"fund",Map.of("orderId",id,"consentNonce",text(order,"consentNonce")),reply->gameCheckout(player,reply,order,choice));};
            }
        }
        player.openInventory(menu.inventory);
    }
    private void gameFailure(Player player,Pending request,String code) {
        Menu previous=request.previous;if(previous==null)throw new IllegalArgumentException("inventory_shop_game_order_required");
        Map<String,Object> order=previous.value;
        if(!order.containsKey("orderId")&&order.get("activeOrder") instanceof Map<?,?> raw){@SuppressWarnings("unchecked") Map<String,Object> snapshot=(Map<String,Object>)raw;order=gameOrder(snapshot,snapshot);}
        if(!Objects.equals(order.get("orderId"),request.fields.get("orderId")))throw new IllegalArgumentException("inventory_shop_game_order_required");
        Menu menu=menu(player,"game_error",order,integer(order.get("count")),"Check Purchase",3);menu.choice=previous.choice.isEmpty()?Map.of("item",text(order,"item"),"unitPriceCity",text(order,"unitPriceCity"),"available",0):previous.choice;menu.back=player::closeInventory;
        menu.inventory.setItem(22,selected(order,menu.count));
        boolean notQueued=code.equals("REQUEST_UNAVAILABLE");
        menu.inventory.setItem(31,icon(Material.CLOCK,"Check the Existing Purchase",notQueued?"Your request was not queued.":"The latest result is not available yet.",notQueued?"Check status, then confirm this order once.":request.action.equals("fund")?"Do not repeat this starter grant.":"Do not send another payment.","Checking status keeps the same order.","Please check again in a moment."));
        primary(menu,"Check purchase","Look up this existing order only.","No repeated payment confirmation.");Map<String,Object> retainedOrder=order;menu.primary=()->gameStatus(player,retainedOrder,menu.choice);player.openInventory(menu.inventory);
    }
    private void outOfStock(Player player,Map<String,Object> entry,int count){
        Menu menu=menu(player,"empty",entry,count,"Material Out of Stock",0);menu.choice=entry;
        menu.inventory.setItem(22,icon(Material.BARRIER,title(text(entry,"item"))+" Is Out of Stock","Your selection: "+count+" items","Choose another material or reload its stock."));
        primary(menu,"Reload Item Stock","Check this material's availability again.");menu.primary=()->reloadChoice(player,entry,count);player.openInventory(menu.inventory);
    }
    @SuppressWarnings("unchecked") private void reloadChoice(Player player,Map<String,Object> choice,int count){request(player,"catalog",Map.of(),value->{
        if(!(value.get("entries") instanceof List<?> entries))throw new IllegalArgumentException("inventory_shop_catalog_required");
        for(Object raw:entries){Map<String,Object> entry=(Map<String,Object>)raw;if(text(entry,"item").equals(text(choice,"item"))){quantity(player,entry,count);return;}}catalog(player,value);
    });}
    private void help(Player player,Menu previous){
        Menu menu=menu(player,"help",Map.of(),1,"How Shopping Works",previous.step);menu.requestId=previous.requestId;menu.back=()->player.openInventory(previous.inventory);
        menu.inventory.setItem(20,icon(Material.CHEST,"1. Choose an Item","Browse the materials that are actually in stock."));
        menu.inventory.setItem(22,icon(Material.HOPPER,"2. Choose a Quantity","Use +1 / −1 for exact numbers.","The total updates after every change."));
        menu.inventory.setItem(24,icon(Material.PAPER,"3. Review Your Order","Check the material, quantity and CITY total."));
        menu.inventory.setItem(31,icon(Material.EMERALD,"4. Pay Inside Minecraft","Review your separate Privy game wallet.","Use the Pay button for the exact displayed total.","A starter grant never makes a purchase."));
        menu.inventory.setItem(40,icon(Material.BOOK,"CITY Test Tokens","This shop uses Unichain Sepolia test tokens.","The payment page shows the maximum test ETH fee."));player.openInventory(menu.inventory);
    }
    private void failed(Player player,Pending request,String code){
        if(Set.of("enroll","confirm","status","fund").contains(request.action)){gameFailure(player,request,code);return;}
        Menu previous=request.previous;Map<String,Object> choice=previous==null?Map.of():previous.choice;int count=previous==null?1:previous.count;
        boolean expired=code.contains("FRESH_QUOTE_REQUIRED"),stock=code.contains("STOCK")||code.contains("MERCHANT");
        Menu menu=menu(player,"error",request.fields,count,expired?"Review Expired":stock?"Stock Changed":"Please Try Again",previous==null?0:previous.step);menu.choice=choice;
        menu.inventory.setItem(22,icon(expired?Material.CLOCK:Material.BARRIER,expired?"Review Expired — Review These Items Again":stock?"The Stock Has Changed":"We Couldn't Load This Step",
            expired?"Refresh the review, then check its total again.":stock?"Reload this material's latest stock.":"Your selection is kept below. Please retry.","Your wallet confirmation is always a separate step."));
        if(!choice.isEmpty())menu.inventory.setItem(31,selected(choice,count));
        if(expired&&previous!=null&&!choice.isEmpty()){
            primary(menu,"Refresh Review","Keep "+count+" "+title(text(choice,"item"))+" selected.","Check the refreshed price before continuing.");
            menu.primary=()->request(player,"quote",Map.of("item",text(choice,"item"),"count",count),value->review(player,value,choice,true));
        }else if(stock&&!choice.isEmpty()){
            primary(menu,"Reload Item Stock","Keep your selected material.");menu.primary=()->reloadChoice(player,choice,count);
        }else{
            primary(menu,request.action.equals("catalog")?"Reload Materials":request.action.equals("quote")?"Retry Review":"Retry Secure Checkout","Keep the same material and quantity.");
            menu.primary=()->request(player,request.action,request.fields,request.show);
        }
        menu.back=previous==null?()->open(player):()->player.openInventory(previous.inventory);player.openInventory(menu.inventory);
    }
    private boolean currentRequest(Player player,String id,String connection){return player.getOpenInventory().getTopInventory().getHolder() instanceof Menu menu&&menu.owner.equals(player.getUniqueId())&&Objects.equals(menu.connection,connection)&&Objects.equals(menu.requestId,id);}
    private boolean currentRequest(Player player,String id,Pending request) {
        return request.collect?player.getOpenInventory().getTopInventory().getType()==org.bukkit.event.inventory.InventoryType.CRAFTING:currentRequest(player,id,request.connection);
    }
    private void request(Player player,String action,Map<String,Object> fields,Consumer<Map<String,Object>> show){request(player,action,fields,show,false);}
    private void request(Player player,String action,Map<String,Object> fields,Consumer<Map<String,Object>> show,boolean collect){
        if(!allowed(player)||!loading.add(player.getUniqueId()))return;
        String connection=connectionId.apply(player);UUID playerId=player.getUniqueId();Menu previous=player.getOpenInventory().getTopInventory().getHolder() instanceof Menu menu?menu:null;
        if(collect)player.closeInventory();
        String id;boolean notQueued=false;try{id=queue.submit(player,action,Map.copyOf(fields));notQueued=id==null;}catch(RuntimeException error){id=null;}
        Pending request=new Pending(playerId,connection,action,Map.copyOf(fields),previous,show,collect);
        if(id==null){
            if(notQueued){
                if(action.equals("fund"))fundingAttempts.remove(text(fields,"orderId"));
                if(action.equals("confirm"))consentAttempts.remove(text(fields,"orderId")+":"+text(fields,"consentNonce"));
            }
            loading.remove(playerId);failed(player,request,notQueued?"REQUEST_UNAVAILABLE":"REQUEST_OUTCOME_UNKNOWN");return;
        }
        pending.put(id,request);
        if(!collect){Menu wait=menu(player,"loading",Map.of(),previous==null?1:previous.count,switch(action){case "catalog"->"Loading Materials";case "quote"->"Checking Your Order";case "enroll"->"Creating Game Wallet";case "confirm"->"Submitting Purchase";case "fund"->"Funding Game Wallet";case "status"->"Checking Purchase";default->"Preparing Checkout";},action.equals("catalog")?0:action.equals("quote")?2:3);
        wait.requestId=id;wait.choice=previous==null?Map.of():previous.choice;wait.back=previous==null?player::closeInventory:()->player.openInventory(previous.inventory);
        wait.inventory.setItem(22,icon(Material.CLOCK,"Please Wait…",action.equals("catalog")?"Loading the available materials.":action.equals("quote")?"Checking stock and the exact CITY total.":"Checking your game wallet purchase.","Payment requires a separate Pay button click."));player.openInventory(wait.inventory);
        }else player.sendMessage("UniRock: collecting this paid order. Keep inventory space free and your cursor empty.");
        String operationId=id;Bukkit.getScheduler().runTaskLater(plugin,()->{if(pending.remove(operationId)!=null){loading.remove(playerId);if(player.isOnline()&&approved.test(player)&&Objects.equals(connection,connectionId.apply(player))&&currentRequest(player,operationId,request))failed(player,request,"REQUEST_TIMEOUT");}},600L);
    }
    public boolean complete(String operationId,Map<String,Object> result){
        if(!Bukkit.isPrimaryThread())throw new IllegalStateException("inventory_shop_main_thread_required");Pending request=pending.remove(operationId);if(request==null)return false;
        loading.remove(request.playerId);Player player=Bukkit.getPlayer(request.playerId);
        if(closed||player==null||!allowed(player)||!Objects.equals(request.connection,connectionId.apply(player))||!currentRequest(player,operationId,request))return false;
        if(result.containsKey("error")){failed(player,request,String.valueOf(result.get("error")));return true;}
        try{request.show.accept(result);}catch(RuntimeException error){failed(player,request,"RESPONSE_UNAVAILABLE");}return true;
    }
    @EventHandler(priority=EventPriority.HIGHEST) public void interact(PlayerInteractEvent event){if(!isButton(event.getItem()))return;event.setCancelled(true);if(event.getAction()==org.bukkit.event.block.Action.RIGHT_CLICK_AIR||event.getAction()==org.bukkit.event.block.Action.RIGHT_CLICK_BLOCK)open(event.getPlayer());}
    @EventHandler(priority=EventPriority.HIGHEST) @SuppressWarnings("unchecked") public void click(InventoryClickEvent event){
        if(!(event.getWhoClicked() instanceof Player player))return;
        if(isButton(event.getCurrentItem())||isButton(event.getCursor())){event.setCancelled(true);Bukkit.getScheduler().runTask(plugin,()->open(player));return;}
        if(!(event.getView().getTopInventory().getHolder() instanceof Menu menu))return;event.setCancelled(true);
        if(!menu.owner.equals(player.getUniqueId())||!Objects.equals(menu.connection,connectionId.apply(player))||!allowed(player)||event.getRawSlot()<0||event.getRawSlot()>=54)return;
        int slot=event.getRawSlot();if(slot==53){player.closeInventory();return;}if(slot==45){menu.back.run();return;}if(slot==47){if(!menu.page.equals("help"))help(player,menu);return;}if(slot==49){if(menu.primary!=null)menu.primary.run();return;}if(slot==43&&menu.fund!=null){menu.fund.run();return;}if(slot==40&&menu.resume!=null){menu.resume.run();return;}
        if(menu.page.equals("catalog")){List<?> entries=(List<?>)menu.value.get("entries");for(int i=0;i<entries.size();i++)if(slot==GOODS[i]){quantity(player,(Map<String,Object>)entries.get(i),1);return;}}
        else if(menu.page.equals("quantity")){
            int change=switch(slot){case 28->-8;case 29->-1;case 33->1;case 34->8;default->0;};if(change!=0){quantity(player,menu.value,menu.count+change);return;}
            int count=switch(slot){case 37->1;case 39->8;case 41->16;case 43->Math.min(64,integer(menu.value.get("available")));default->0;};if(count>0&&count<=integer(menu.value.get("available")))quantity(player,menu.value,count);
        }
    }
    @EventHandler(priority=EventPriority.HIGHEST) public void drag(InventoryDragEvent event){if(owns(event.getView().getTopInventory())||isButton(event.getOldCursor()))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void drop(PlayerDropItemEvent event){if(isButton(event.getItemDrop().getItemStack()))event.setCancelled(true);}
    @EventHandler public void died(PlayerDeathEvent event){event.getDrops().removeIf(this::isButton);}
    @EventHandler public void respawned(PlayerRespawnEvent event){Bukkit.getScheduler().runTask(plugin,()->giveButton(event.getPlayer()));}
    @EventHandler public void craft(PrepareItemCraftEvent event){for(ItemStack item:event.getInventory().getMatrix())if(isButton(item)){event.getInventory().setResult(null);return;}}
    @EventHandler public void left(PlayerQuitEvent event){loading.remove(event.getPlayer().getUniqueId());}
}
