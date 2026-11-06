package org.agentcity.paper;

import java.lang.reflect.InvocationTargetException;
import java.util.Map;

/** Real compiled Java arithmetic; native menu/wire checks run separately in Paper. */
public final class InventoryMarketplacePriceTest {
    public static void main(String[] args) throws Exception {
        var total=InventoryMarketplace.class.getDeclaredMethod("total",Map.class,int.class);total.setAccessible(true);
        if(!"0.5".equals(total.invoke(null,Map.of("unitPriceCity","0.125"),4)))throw new AssertionError("four_item_total");
        if(!"0.400000000000000004".equals(total.invoke(null,Map.of("unitPriceCity","0.100000000000000001"),4)))throw new AssertionError("city_decimal_precision");
        try{total.invoke(null,Map.of("unitPriceCity","-1"),4);throw new AssertionError("negative_price_accepted");}
        catch(InvocationTargetException refused){if(!(refused.getCause() instanceof IllegalArgumentException))throw refused;}
        System.out.println("PASS four-item CITY total, exact 18-decimal arithmetic and negative price refusal; no payment or server actions");
    }
}
