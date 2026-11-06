package org.agentcity.paper;

import java.util.*;
import java.util.function.*;
import org.bukkit.*;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.inventory.*;
import org.bukkit.inventory.*;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;

/** Optional test-token investments. Only the explicit review button queues consent. */
public final class InvestmentMenu implements Listener {
    private final JavaPlugin plugin;
    private final Predicate<Player> approved;
    private final Function<Player,String> connection;
    private final InventoryMarketplace.Queue queue;
    private record Pending(UUID player,String connection,Consumer<Map<String,Object>> show) {}
    private final Map<String,Pending> pending=new HashMap<>();
    private final Set<UUID> loading=new HashSet<>();
    private static final class Menu implements InventoryHolder {
        final UUID owner; final String connection; final Map<Integer,Runnable> buttons=new HashMap<>(); Inventory inventory; String request;
        Menu(Player p,String connection){owner=p.getUniqueId();this.connection=connection;}
        public Inventory getInventory(){return inventory;}
    }
    public InvestmentMenu(JavaPlugin plugin,Predicate<Player> approved,Function<Player,String> connection,InventoryMarketplace.Queue queue){this.plugin=plugin;this.approved=approved;this.connection=connection;this.queue=queue;}
    public void start(){Bukkit.getPluginManager().registerEvents(this,plugin);}
    public void close(){pending.clear();loading.clear();HandlerList.unregisterAll(this);}
    public static boolean owns(Inventory i){return i!=null&&i.getHolder() instanceof Menu;}
    private ItemStack icon(Material material,String title,String... lines){ItemStack i=new ItemStack(material);ItemMeta m=i.getItemMeta();m.setDisplayName(ChatColor.WHITE+title);m.setLore(Arrays.stream(lines).map(s->ChatColor.GRAY+s).toList());i.setItemMeta(m);return i;}
    private Menu menu(Player p,String title){Menu m=new Menu(p,connection.apply(p));m.inventory=Bukkit.createInventory(m,54,"UniRock | "+title);for(int i=0;i<54;i++)m.inventory.setItem(i,icon(Material.BLACK_STAINED_GLASS_PANE," "));
        button(m,45,Material.ARROW,"Investments",()->open(p));button(m,53,Material.BARRIER,"Close",p::closeInventory);return m;}
    private void button(Menu m,int slot,Material icon,String label,Runnable action,String... lore){m.inventory.setItem(slot,icon(icon,label,lore));m.buttons.put(slot,action);}
    private boolean allowed(Player p){if(!approved.test(p)){p.sendMessage("Approve your current Minecraft connection with Discord /join first.");return false;}return true;}
    public void open(Player p){request(p,"invest_portfolio",Map.of(),v->home(p,v));}
    private void request(Player p,String action,Map<String,Object> fields,Consumer<Map<String,Object>> show){
        if(!allowed(p)||!loading.add(p.getUniqueId()))return;
        String id=queue.submit(p,action,fields);if(id==null){loading.remove(p.getUniqueId());p.sendMessage("Investment request was not queued. Nothing new was authorized.");return;}
        pending.put(id,new Pending(p.getUniqueId(),connection.apply(p),show));Menu m=menu(p,"Checking Investment");m.request=id;
        m.inventory.setItem(22,icon(Material.CLOCK,"Checking the same operation","No automatic slippage changes or new payment.","A timeout does not mean a transaction failed."));p.openInventory(m.inventory);
        Bukkit.getScheduler().runTaskLater(plugin,()->{Pending old=pending.remove(id);if(old!=null){loading.remove(old.player);if(p.isOnline()&&current(p,m)){Menu e=menu(p,"Check Again");e.inventory.setItem(22,icon(Material.CLOCK,"Request still pending","Use /invest to resume the same operation.","Do not create another deposit to recover."));p.openInventory(e.inventory);}}},600L);
    }
    private boolean current(Player p,Menu m){return allowed(p)&&m.owner.equals(p.getUniqueId())&&Objects.equals(m.connection,connection.apply(p))&&p.getOpenInventory().getTopInventory()==m.inventory;}
    public boolean complete(String id,Map<String,Object> value){
        Pending old=pending.remove(id);if(old==null)return false;loading.remove(old.player);Player p=Bukkit.getPlayer(old.player);
        if(p==null||!allowed(p)||!Objects.equals(old.connection,connection.apply(p))||!(p.getOpenInventory().getTopInventory().getHolder() instanceof Menu m)||!Objects.equals(id,m.request))return false;
        if(value.get("error")!=null){Menu error=menu(p,"Investment Unavailable");error.inventory.setItem(22,icon(Material.BARRIER,"This step is blocked",String.valueOf(value.get("error")),"Shop permissions never authorize investing.","Existing payments and positions are preserved."));p.openInventory(error.inventory);return true;}
        try{old.show.accept(value);}catch(RuntimeException e){p.closeInventory();p.sendMessage("Investment response unavailable. /invest resumes existing records; do not pay again.");}return true;
    }
    @SuppressWarnings("unchecked") private void home(Player p,Map<String,Object> state){
        Menu m=menu(p,"Optional Investments");m.inventory.setItem(4,icon(Material.BEACON,"Optional Testnet Investments","Unichain Sepolia · test tokens only","LPing can lose value. No guaranteed yield."));
        button(m,12,Material.EMERALD_BLOCK,"New CITY / tUSDC Position",()->deposit(p),"Choose maximum deposits, then review.");
        button(m,14,Material.ENDER_PEARL,"Swap Test Tokens",()->{p.closeInventory();p.sendMessage("/invest swap <output amount in base units> <CITY|tUSDC> <CITY|tUSDC> <maximum input base units>");p.sendMessage("Example: /invest swap 1000000 CITY tUSDC 2000000000000000000");},"Review output, maximum spending and expiry.","Guarded public RPC; no private MEV guarantee.");
        button(m,16,Material.MAP,"Compare API Routes",()->{p.closeInventory();p.sendMessage("/invest routes <CITY|tUSDC|GEM> <CITY|tUSDC|GEM> <output base units>");},"Only approved pools may pass the route filter.","Unprotected API routes cannot execute.");
        m.inventory.setItem(22,icon(Material.PAPER,"Your Existing Privy Game Wallet",String.valueOf(state.get("walletAddress")),"Deposits are separate from shop payments."));
        if(state.get("operations") instanceof List<?> ops&&!ops.isEmpty()){Map<String,Object> op=(Map<String,Object>)ops.getFirst();button(m,40,Material.CLOCK,"Resume Latest Investment",()->request(p,"invest_status",Map.of("operationId",op.get("operationId")),v->review(p,v,0)),"Checks the existing transaction journal.","Does not authorize another investment.");}
        if(state.get("positions") instanceof List<?> positions){int slot=28;for(Object raw:positions){if(slot>34)break;Map<String,Object> v=(Map<String,Object>)raw;String id=String.valueOf(v.get("tokenId"));button(m,slot++,Material.GOLD_INGOT,"LP Position #"+id,()->position(p,v),"In range: "+v.get("inRange"),"Principal (pool token order): "+v.get("principal"),"Unclaimed fees: "+v.get("fees"));}}
        p.openInventory(m.inventory);
    }
    private void deposit(Player p){Menu m=menu(p,"Choose LP Deposit");int slot=20;for(String amount:List.of("0.01","0.1","1","5")){button(m,slot++,Material.EMERALD,"Up to "+amount+" CITY + "+amount+" tUSDC",()->request(p,"invest_preview",Map.of("action","deposit","city",amount,"usdc",amount),v->review(p,v,0)),"Current price +/- 600 ticks.","Review exact amounts, range and gas next.");}
        m.inventory.setItem(31,icon(Material.BOOK,"Custom Deposit / Price Range","/invest deposit <CITY> <tUSDC>","Optionally append <lower tick> <upper tick>","Ticks must be multiples of 60.","At most 10 CITY and 10 tUSDC per review."));p.openInventory(m.inventory);}
    private void position(Player p,Map<String,Object> v){String id=String.valueOf(v.get("tokenId"));Menu m=menu(p,"LP Position #"+id);
        m.inventory.setItem(4,icon(Material.PAPER,"Position #"+id,"Owner: "+v.get("owner"),"In range: "+v.get("inRange"),"Unclaimed fees: "+v.get("fees")));
        button(m,20,Material.EMERALD_BLOCK,"Preview Add 0.1 + 0.1",()->request(p,"invest_preview",Map.of("action","increase","tokenId",id,"city","0.1","usdc","0.1"),r->review(p,r,0)),"Exact maximums shown before confirmation.");
        button(m,22,Material.GOLD_INGOT,"Preview Collect Fees",()->request(p,"invest_preview",Map.of("action","collect","tokenId",id),r->review(p,r,0)),"Preserves your liquidity and NFT.");
        button(m,24,Material.HOPPER,"Preview Withdraw All",()->request(p,"invest_preview",Map.of("action","withdraw","tokenId",id,"withdrawBps",10000),r->review(p,r,0)),"Minimum outputs shown before confirmation.","Withdrawal stays available when swaps halt.");p.openInventory(m.inventory);}
    @SuppressWarnings("unchecked") private void review(Player p,Map<String,Object> v,int page){
        Menu m=menu(p,"Investment Review");List<String> lines=v.get("lines") instanceof List<?> raw?raw.stream().map(String::valueOf).toList():List.of();
        int pages=Math.max(1,(lines.size()+6)/7),start=Math.min(page,pages-1)*7;for(int i=start;i<Math.min(start+7,lines.size());i++)m.inventory.setItem(19+i-start,icon(Material.PAPER,"Detail "+(i+1),wrap(lines.get(i))));
        m.inventory.setItem(4,icon(Material.NETHER_STAR,"Review "+v.get("action"),"State: "+v.get("status"),"Page "+(page+1)+" / "+pages,"Wallet: "+v.get("walletAddress")));
        if(page>0)button(m,37,Material.ARROW,"Previous Details",()->review(p,v,page-1));
        if(page+1<pages)button(m,43,Material.ARROW,"Next Details",()->review(p,v,page+1));
        String id=String.valueOf(v.get("operationId")),nonce=String.valueOf(v.get("consentNonce"));
        if("preview".equals(v.get("status"))&&Boolean.FALSE.equals(v.get("canConfirm")))m.inventory.setItem(49,icon(Material.BARRIER,"Test Funds Needed",wrap(String.valueOf(v.get("blocker")))));
        else if("preview".equals(v.get("status"))&&page+1>=pages)button(m,49,Material.LIME_CONCRETE,"Confirm This Investment",()->request(p,"invest_confirm",Map.of("operationId",id,"consentNonce",nonce),r->review(p,r,0)),"Explicitly authorize only the reviewed operation.","This is separate from agent shop permission.","No automatic fallback or slippage increase.");
        else if(!"preview".equals(v.get("status")))button(m,49,Material.CLOCK,"Check Same Operation",()->request(p,"invest_status",Map.of("operationId",id),r->review(p,r,0)),"Reconcile existing signed bytes only.");
        p.openInventory(m.inventory);
    }
    private String[] wrap(String text){List<String> lines=new ArrayList<>();for(int i=0;i<text.length();i+=65)lines.add(text.substring(i,Math.min(i+65,text.length())));return lines.toArray(String[]::new);}
    public void command(Player p,String[] parts){
        if(parts.length==1){open(p);return;}
        try{
            if(parts[1].equalsIgnoreCase("deposit")&&(parts.length==4||parts.length==6)){Map<String,Object> fields=new LinkedHashMap<>(Map.of("action","deposit","city",parts[2],"usdc",parts[3]));if(parts.length==6){fields.put("tickLower",Integer.parseInt(parts[4]));fields.put("tickUpper",Integer.parseInt(parts[5]));}request(p,"invest_preview",fields,v->review(p,v,0));return;}
            if(parts[1].equalsIgnoreCase("position")&&parts.length==3){request(p,"invest_portfolio",Map.of("tokenId",parts[2]),v->home(p,v));return;}
            if(parts[1].equalsIgnoreCase("swap")&&parts.length==6){request(p,"invest_preview",Map.of("action","swap","amountOut",parts[2],"tokenIn",parts[3],"tokenOut",parts[4],"maximumInput",parts[5]),v->review(p,v,0));return;}
            if(parts[1].equalsIgnoreCase("routes")&&parts.length==5){request(p,"invest_routes",Map.of("tokenIn",parts[2],"tokenOut",parts[3],"amountOut",parts[4]),v->{p.closeInventory();p.sendMessage(String.valueOf(v.get("message")));p.sendMessage(String.valueOf(v.get("routes")));});return;}
        }catch(NumberFormatException e){p.sendMessage("Ticks must be whole multiples of 60.");return;}
        p.sendMessage("/invest | /invest deposit <CITY> <tUSDC> [lowerTick upperTick] | /invest position <NFT id>");
    }
    @EventHandler(priority=EventPriority.HIGHEST) public void click(InventoryClickEvent e){if(!(e.getWhoClicked() instanceof Player p)||!(e.getView().getTopInventory().getHolder() instanceof Menu m))return;e.setCancelled(true);if(current(p,m)){Runnable action=m.buttons.get(e.getRawSlot());if(action!=null)action.run();}}
    @EventHandler(priority=EventPriority.HIGHEST) public void drag(InventoryDragEvent e){if(owns(e.getView().getTopInventory()))e.setCancelled(true);}
}
